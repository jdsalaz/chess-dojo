import { BatchGetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { Chess, DiagramComment, Move } from '@jackstenglein/chess';
import {
    MergeMultipleRequest,
    MergeMultipleSchema,
    PgnMergeType,
    PgnMergeTypes,
} from '@jackstenglein/chess-dojo-common/src/pgn/merge';
import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
    ApiError,
    errToApiGatewayProxyResultV2,
    parseBody,
    requireUserInfo,
} from '../../directoryService/api';
import { dynamo, gamesTable, success } from './create';
import { Game } from './types';

const frontendHost = process.env['frontendHost'];

/**
 * Lambda handler that merges multiple games into a single new game.
 * @param event The event that triggered the Lambda.
 * @returns The cohort and id of the newly created game.
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
    try {
        console.log('Event: %j', event);

        const userInfo = requireUserInfo(event);
        const request = parseBody(event, MergeMultipleSchema);

        // Fetch all games
        const games = await fetchGames(request.games);

        // Verify the caller can access all games (must be owner or game must be public)
        for (const game of games) {
            if (game.owner !== userInfo.username && game.unlisted) {
                throw new ApiError({
                    statusCode: 403,
                    publicMessage:
                        'Permission denied: you can only merge your own games or public games',
                });
            }
        }

        // Find the header source game
        const headerSourceGame = games.find(
            (g) =>
                g.cohort === request.headerSource.cohort &&
                g.id === request.headerSource.id,
        );
        if (!headerSourceGame) {
            throw new ApiError({
                statusCode: 400,
                publicMessage:
                    'Invalid request: headerSource must be one of the games in the list',
            });
        }

        // Start with the header source game as the base
        const target = new Chess({ pgn: headerSourceGame.pgn });
        target.seek(null);

        // Merge all other games into the target
        for (const game of games) {
            if (game.cohort === headerSourceGame.cohort && game.id === headerSourceGame.id) {
                continue;
            }

            const source = new Chess({ pgn: game.pgn });
            source.seek(null);

            recursiveMergeLine(source.history(), source, target, null, request, game);
        }

        // Create a new game with the merged PGN
        const mergedPgn = target.renderPgn();
        const now = new Date();
        const uploadDate = now.toISOString().slice(0, '2024-01-01'.length);
        const headers = target.header().valueMap();

        const newGame: Game = {
            cohort: headerSourceGame.cohort,
            id: `${uploadDate.replaceAll('-', '.')}_${uuidv4()}`,
            white: headers.White?.toLowerCase() || '?',
            black: headers.Black?.toLowerCase() || '?',
            date: headers.Date || '',
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            owner: userInfo.username,
            ownerDisplayName: headerSourceGame.ownerDisplayName || '',
            ownerPreviousCohort: headerSourceGame.ownerPreviousCohort || '',
            headers,
            pgn: mergedPgn,
            orientation: headerSourceGame.orientation || 'white',
            comments: [],
            positionComments: {},
            unlisted: true,
        };

        await putGame(newGame);

        return success({ cohort: newGame.cohort, id: newGame.id });
    } catch (err) {
        return errToApiGatewayProxyResultV2(err);
    }
};

/**
 * Fetches all games with the provided keys from DynamoDB using BatchGetItem.
 * @param gameKeys The cohort/id pairs to fetch.
 * @returns The fetched games.
 */
async function fetchGames(
    gameKeys: { cohort: string; id: string }[],
): Promise<Game[]> {
    const games: Game[] = [];
    let keys: Record<string, { S: string }>[] = gameKeys.map(({ cohort, id }) => ({
        cohort: { S: cohort },
        id: { S: id },
    }));

    while (keys.length > 0) {
        const response = await dynamo.send(
            new BatchGetItemCommand({
                RequestItems: {
                    [gamesTable]: {
                        Keys: keys,
                    },
                },
            }),
        );

        const items = response.Responses?.[gamesTable] ?? [];
        for (const item of items) {
            games.push(unmarshall(item) as Game);
        }

        keys = (response.UnprocessedKeys?.[gamesTable]?.Keys ?? []) as typeof keys;
    }

    if (games.length !== gameKeys.length) {
        const foundKeys = new Set(games.map((g) => `${g.cohort}/${g.id}`));
        const missing = gameKeys.find(
            ({ cohort, id }) => !foundKeys.has(`${cohort}/${id}`),
        );
        throw new ApiError({
            statusCode: 404,
            publicMessage: `Game ${missing?.cohort}/${missing?.id} not found`,
        });
    }

    return games;
}

/**
 * Saves a game to DynamoDB.
 * @param game The game to save.
 */
async function putGame(game: Game) {
    await dynamo.send(
        new PutItemCommand({
            Item: marshall(game, { removeUndefinedValues: true }),
            TableName: gamesTable,
        }),
    );
}

/**
 * Recursively merges the given line into the target Chess instance.
 * Unlike the single-game merge, this does not require matching starting positions.
 * @param line The line to merge into the Chess instance.
 * @param source The source Chess instance being merged.
 * @param target The target Chess to merge the line into.
 * @param currentTargetMove The current move to start from in the target Chess.
 * @param request The merge options.
 * @param game The source game, used for citation when citeSource is enabled.
 */
function recursiveMergeLine(
    line: Move[],
    source: Chess,
    target: Chess,
    currentTargetMove: Move | null,
    request: MergeMultipleRequest,
    game: Game,
) {
    for (const move of line) {
        const newTargetMove = target.move(move.san, {
            previousMove: currentTargetMove,
            skipSeek: true,
        });
        if (!newTargetMove) {
            throw new ApiError({
                statusCode: 400,
                publicMessage: `Unable to merge: invalid move ${move.san} at ply ${move.ply}`,
            });
        }

        mergeComments(move, newTargetMove, request.commentMergeType);
        mergeNags(move, newTargetMove, request.nagMergeType);
        mergeDrawables(move, newTargetMove, request.drawableMergeType);

        for (const variation of move.variations) {
            recursiveMergeLine(variation, source, target, currentTargetMove, request, game);
        }

        currentTargetMove = newTargetMove;
    }

    if (request.citeSource && currentTargetMove) {
        const white = getPlayer(
            source.header().tags.White,
            source.header().tags.WhiteElo?.value,
        );
        const black = getPlayer(
            source.header().tags.Black,
            source.header().tags.BlackElo?.value,
        );
        const date = source.header().getRawValue('Date');
        const comment = `[${white} - ${black}${date ? ` ${date}` : ''}](${frontendHost}/games/${game.cohort}/${game.id})`;

        if (currentTargetMove.commentAfter) {
            currentTargetMove.commentAfter += `\n\n${comment}`;
        } else {
            currentTargetMove.commentAfter = comment;
        }
    }
}

/**
 * Returns a display string for the given player/ELO.
 * @param name The name of the player.
 * @param elo The ELO of the player.
 */
function getPlayer(name: string | undefined, elo: string | undefined): string {
    let result = name || 'NN';
    if (elo) {
        return `${result} (${elo})`;
    }
    return result;
}

/**
 * Merges the comments from the given source move into the target move.
 */
function mergeComments(source: Move, target: Move, mergeType: PgnMergeType) {
    if (mergeType === PgnMergeTypes.DISCARD) {
        return;
    }

    if (source.commentAfter) {
        if (mergeType === PgnMergeTypes.OVERWRITE || !target.commentAfter) {
            target.commentAfter = source.commentAfter;
        } else {
            target.commentAfter += `\n\n${source.commentAfter}`;
        }
    }

    if (source.commentMove) {
        if (mergeType === PgnMergeTypes.OVERWRITE || !target.commentMove) {
            target.commentMove = source.commentMove;
        } else {
            target.commentMove += `\n\n${source.commentMove}`;
        }
    }
}

/**
 * Merges the NAGs from the given source move into the target move.
 */
function mergeNags(source: Move, target: Move, mergeType: PgnMergeType) {
    if (mergeType === PgnMergeTypes.DISCARD) {
        return;
    }

    if (source.nags) {
        if (mergeType === PgnMergeTypes.OVERWRITE || !target.nags) {
            target.nags = source.nags;
        } else {
            target.nags.push(...source.nags);
            target.nags = target.nags.filter(
                (nag, index) => target.nags?.indexOf(nag) === index,
            );
        }
    }
}

/**
 * Merges the color arrows and color fields from the given source move into the target move.
 */
function mergeDrawables(source: Move, target: Move, mergeType: PgnMergeType) {
    if (mergeType === PgnMergeTypes.DISCARD) {
        return;
    }

    if (source.commentDiag?.colorArrows) {
        if (mergeType === PgnMergeTypes.OVERWRITE || !target.commentDiag?.colorArrows) {
            target.commentDiag = {
                ...target.commentDiag,
                colorArrows: source.commentDiag.colorArrows,
            } as DiagramComment;
        } else {
            target.commentDiag.colorArrows.push(...source.commentDiag.colorArrows);
            target.commentDiag.colorArrows = target.commentDiag.colorArrows.filter(
                (arrow, index) => target.commentDiag?.colorArrows?.indexOf(arrow) === index,
            );
        }
    }

    if (source.commentDiag?.colorFields) {
        if (mergeType === PgnMergeTypes.OVERWRITE || !target.commentDiag?.colorFields) {
            target.commentDiag = {
                ...target.commentDiag,
                colorFields: source.commentDiag.colorFields,
            } as DiagramComment;
        } else {
            target.commentDiag.colorFields.push(...source.commentDiag.colorFields);
            target.commentDiag.colorFields = target.commentDiag.colorFields.filter(
                (arrow, index) => target.commentDiag?.colorFields?.indexOf(arrow) === index,
            );
        }
    }
}
