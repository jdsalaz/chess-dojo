package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/jackstenglein/chess-dojo-scheduler/backend/api"
	"github.com/jackstenglein/chess-dojo-scheduler/backend/api/errors"
	"github.com/jackstenglein/chess-dojo-scheduler/backend/api/log"
	"github.com/jackstenglein/chess-dojo-scheduler/backend/database"
	treeapi "github.com/jackstenglein/chess-dojo-scheduler/backend/openingTreeService/api"
	"github.com/jackstenglein/chess-dojo-scheduler/backend/openingTreeService/chesscom"
	"github.com/jackstenglein/chess-dojo-scheduler/backend/openingTreeService/game"
	"github.com/jackstenglein/chess-dojo-scheduler/backend/openingTreeService/lichess"
	"github.com/jackstenglein/chess-dojo-scheduler/backend/openingTreeService/openingtree"
)

const (
	// DefaultMaxGames is the maximum number of games to index when the
	// MAX_GAMES environment variable is not set. This prevents Lambda
	// response payloads from exceeding the 6 MB limit.
	DefaultMaxGames = 1500
)

var repository database.UserGetter = database.DynamoDB

type Source struct {
	Type     game.SourceType `json:"type"`
	Username string          `json:"username"`
}

type BuildRequest struct {
	Sources []Source `json:"sources"`
	Since   *time.Time `json:"since,omitempty"`
	Until   *time.Time `json:"until,omitempty"`
}

// SourceError reports a per-source fetch failure. The frontend can display
// which sources succeeded and which failed.
type SourceError struct {
	Source   game.SourceType `json:"source"`
	Username string          `json:"username"`
	Error    string          `json:"error"`
}

// BuildResponse is the JSON payload returned by the handler.
type BuildResponse struct {
	*treeapi.Response
	SourceErrors     []SourceError `json:"sourceErrors,omitempty"`
	GameLimit        int           `json:"gameLimit"`
	GameLimitExceeded bool         `json:"gameLimitExceeded"`
}

// fetchResult carries either a game or an error from a source fetcher goroutine.
type fetchResult struct {
	game game.Game
	err  error
	src  Source
}

func main() {
	lambda.Start(handler)
}

func handler(ctx context.Context, event api.Request) (api.Response, error) {
	log.SetRequestId(event.RequestContext.RequestID)
	log.Infof("Event: %#v", event)

	info := api.GetUserInfo(event)
	if info.Username == "" {
		return api.Failure(errors.New(400, "Invalid request: authorization is required", "")), nil
	}

	user, err := repository.GetUser(info.Username)
	if err != nil {
		return api.Failure(err), nil
	}
	if user.SubscriptionStatus != database.SubscriptionStatus_Subscribed {
		return api.Failure(errors.New(403, "Forbidden: active subscription required", "")), nil
	}

	var req BuildRequest
	if err := json.Unmarshal([]byte(event.Body), &req); err != nil {
		return api.Failure(errors.New(400, "Invalid request: unable to parse body", "")), nil
	}
	if len(req.Sources) == 0 {
		return api.Failure(errors.New(400, "Invalid request: at least one source is required", "")), nil
	}
	const maxSources = 10
	if len(req.Sources) > maxSources {
		return api.Failure(errors.New(400, fmt.Sprintf("Invalid request: at most %d sources are allowed", maxSources), "")), nil
	}

	// Validate all sources upfront before starting goroutines.
	for _, src := range req.Sources {
		if src.Username == "" {
			return api.Failure(errors.New(400, "Invalid request: source username is required", "")), nil
		}
		switch src.Type {
		case game.SourceChessCom, game.SourceLichess:
		default:
			return api.Failure(errors.New(400, "Invalid request: source type must be 'chesscom' or 'lichess'", "")), nil
		}
	}

	maxGames := getMaxGames()

	// Fan out: fetch games from all sources concurrently.
	// Use a cancellable context so fetchers stop when the game limit is reached.
	fetchCtx, cancelFetch := context.WithCancel(ctx)
	defer cancelFetch()

	results := make(chan fetchResult, 64)
	var wg sync.WaitGroup

	for _, src := range req.Sources {
		wg.Add(1)
		go func(src Source) {
			defer wg.Done()

			since, until := timeOrZero(req.Since), timeOrZero(req.Until)

			var games func(func(game.Game, error) bool)
			switch src.Type {
			case game.SourceChessCom:
				client := chesscom.NewClient()
				games = client.Games(fetchCtx, src.Username, since, until, true)
			case game.SourceLichess:
				client := lichess.NewClient(nil)
				games = client.Games(fetchCtx, lichess.FetchParams{
					Username: src.Username,
					Since:    since,
					Until:    until,
				})
			}

			for g, err := range games {
				if err != nil {
					// Don't report context cancellation as a source error;
					// it means we hit the game limit.
					if fetchCtx.Err() != nil {
						return
					}
					results <- fetchResult{err: err, src: src}
					return
				}
				select {
				case results <- fetchResult{game: g, src: src}:
				case <-fetchCtx.Done():
					return
				}
			}
		}(src)
	}

	// Close results channel once all fetchers complete.
	go func() {
		wg.Wait()
		close(results)
	}()

	// Fan in: index games into the tree as they arrive (single-goroutine, no mutex needed).
	tree := openingtree.New()
	sourceErrors := make(map[string]SourceError)
	gameLimitExceeded := false

	for r := range results {
		if r.err != nil {
			key := fmt.Sprintf("%s:%s", r.src.Type, r.src.Username)
			if _, exists := sourceErrors[key]; !exists {
				log.Errorf("Error fetching game from %s for %s: %v", r.src.Type, r.src.Username, r.err)
				sourceErrors[key] = SourceError{
					Source:   r.src.Type,
					Username: r.src.Username,
					Error:    r.err.Error(),
				}
			}
			continue
		}
		if tree.GameCount() >= maxGames {
			gameLimitExceeded = true
			cancelFetch()
			// Drain remaining results from the channel.
			for range results {
			}
			break
		}
		if _, err := tree.IndexGame(&r.game); err != nil {
			log.Warnf("Failed to index game %s: %v", r.game.URL, err)
		}
	}

	log.Infof("Built tree: %d games, %d positions, %d source errors, limit exceeded: %v",
		tree.GameCount(), tree.PositionCount(), len(sourceErrors), gameLimitExceeded)

	var srcErrs []SourceError
	for _, se := range sourceErrors {
		srcErrs = append(srcErrs, se)
	}
	sort.Slice(srcErrs, func(i, j int) bool {
		if srcErrs[i].Source != srcErrs[j].Source {
			return srcErrs[i].Source < srcErrs[j].Source
		}
		return srcErrs[i].Username < srcErrs[j].Username
	})

	resp := BuildResponse{
		Response:          treeapi.FromOpeningTree(tree),
		SourceErrors:      srcErrs,
		GameLimit:         maxGames,
		GameLimitExceeded: gameLimitExceeded,
	}
	return api.Success(resp), nil
}

// getMaxGames returns the game limit from the MAX_GAMES environment variable,
// falling back to DefaultMaxGames.
func getMaxGames() int {
	if v := os.Getenv("MAX_GAMES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return DefaultMaxGames
}

// timeOrZero dereferences a *time.Time, returning the zero value if nil.
func timeOrZero(t *time.Time) time.Time {
	if t == nil {
		return time.Time{}
	}
	return *t
}
