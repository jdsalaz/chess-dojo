import { useApi } from '@/api/Api';
import { RequestSnackbar, useRequest } from '@/api/Request';
import { GameInfo } from '@/database/game';
import { PgnMergeType, PgnMergeTypes } from '@jackstenglein/chess-dojo-common/src/pgn/merge';
import { LoadingButton } from '@mui/lab';
import {
    Button,
    Checkbox,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    FormGroup,
    FormLabel,
    ListItemText,
    MenuItem,
    Stack,
    TextField,
    Typography,
} from '@mui/material';
import { useState } from 'react';

const mergeTypeLabels = {
    [PgnMergeTypes.MERGE]: 'Merge',
    [PgnMergeTypes.DISCARD]: 'Ignore',
    [PgnMergeTypes.OVERWRITE]: 'Overwrite',
};

export function MergeGamesDialog({
    games,
    onClose,
}: {
    games: GameInfo[];
    onClose: () => void;
}) {
    const api = useApi();
    const request = useRequest<{ cohort: string; id: string }>();

    const [headerSource, setHeaderSource] = useState(0);
    const [commentMergeType, setCommentMergeType] = useState<PgnMergeType>(PgnMergeTypes.MERGE);
    const [nagMergeType, setNagMergeType] = useState<PgnMergeType>(PgnMergeTypes.MERGE);
    const [drawableMergeType, setDrawableMergeType] = useState<PgnMergeType>(PgnMergeTypes.MERGE);
    const [citeSource, setCiteSource] = useState(true);

    const gameLabel = (game: GameInfo) => {
        const white = game.headers?.White || '?';
        const black = game.headers?.Black || '?';
        const date = game.headers?.Date || '';
        return `${white} vs ${black}${date ? ` (${date})` : ''}`;
    };

    const onMerge = async () => {
        const gameKeys = games.map((g) => ({ cohort: g.cohort, id: g.id }));
        const headerSourceGame = gameKeys[headerSource] || gameKeys[0];

        try {
            request.onStart();
            const response = await api.mergeMultipleGames({
                games: gameKeys,
                headerSource: headerSourceGame,
                commentMergeType,
                nagMergeType,
                drawableMergeType,
                citeSource,
            });
            request.onSuccess(response.data);
            onClose();
            const cohort = response.data.cohort.replaceAll('+', '%2B');
            const id = response.data.id.replaceAll('?', '%3F');
            window.open(`/games/${cohort}/${id}`, '_blank');
        } catch (err) {
            request.onFailure(err);
        }
    };

    const handleClose = () => {
        if (request.isLoading()) {
            return;
        }
        onClose();
    };

    return (
        <>
            <RequestSnackbar request={request} />

            <Dialog open onClose={handleClose} fullWidth maxWidth='sm'>
                <DialogTitle>Merge {games.length} Games</DialogTitle>
                <DialogContent>
                    <Stack spacing={2}>
                        <div>
                            <FormLabel>Selected Games</FormLabel>
                            {games.map((game, i) => (
                                <Typography key={`${game.cohort}/${game.id}`} variant='body2'>
                                    {i + 1}. {gameLabel(game)}
                                </Typography>
                            ))}
                        </div>

                        <TextField
                            label='Use headers from'
                            select
                            fullWidth
                            value={headerSource}
                            onChange={(e) => setHeaderSource(Number(e.target.value))}
                            size='small'
                        >
                            {games.map((game, i) => (
                                <MenuItem key={`${game.cohort}/${game.id}`} value={i}>
                                    {gameLabel(game)}
                                </MenuItem>
                            ))}
                        </TextField>

                        <FormGroup>
                            <FormLabel>Merge Options</FormLabel>
                            <Stack direction='row' flexWrap='wrap' columnGap={1} mt={1}>
                                <TextField
                                    label='Comments'
                                    select
                                    value={commentMergeType}
                                    onChange={(e) =>
                                        setCommentMergeType(e.target.value as PgnMergeType)
                                    }
                                    slotProps={{
                                        select: {
                                            renderValue: (value) =>
                                                mergeTypeLabels[value as PgnMergeType],
                                        },
                                    }}
                                    size='small'
                                    sx={{ minWidth: '116px' }}
                                >
                                    <MenuItem value={PgnMergeTypes.MERGE}>
                                        <ListItemText
                                            primary='Merge'
                                            secondary='Comments from each game will be combined'
                                        />
                                    </MenuItem>
                                    <MenuItem value={PgnMergeTypes.OVERWRITE}>
                                        <ListItemText
                                            primary='Overwrite'
                                            secondary='Comments from later games overwrite earlier ones'
                                        />
                                    </MenuItem>
                                    <MenuItem value={PgnMergeTypes.DISCARD}>
                                        <ListItemText
                                            primary='Ignore'
                                            secondary='Comments from non-header-source games are ignored'
                                        />
                                    </MenuItem>
                                </TextField>

                                <TextField
                                    label='Glyphs'
                                    select
                                    value={nagMergeType}
                                    onChange={(e) =>
                                        setNagMergeType(e.target.value as PgnMergeType)
                                    }
                                    slotProps={{
                                        select: {
                                            renderValue: (value) =>
                                                mergeTypeLabels[value as PgnMergeType],
                                        },
                                    }}
                                    size='small'
                                    sx={{ minWidth: '116px' }}
                                >
                                    <MenuItem value={PgnMergeTypes.MERGE}>
                                        <ListItemText
                                            primary='Merge'
                                            secondary='Glyphs from each game will be combined'
                                        />
                                    </MenuItem>
                                    <MenuItem value={PgnMergeTypes.OVERWRITE}>
                                        <ListItemText
                                            primary='Overwrite'
                                            secondary='Glyphs from later games overwrite earlier ones'
                                        />
                                    </MenuItem>
                                    <MenuItem value={PgnMergeTypes.DISCARD}>
                                        <ListItemText
                                            primary='Ignore'
                                            secondary='Glyphs from non-header-source games are ignored'
                                        />
                                    </MenuItem>
                                </TextField>

                                <TextField
                                    label='Arrows/Highlights'
                                    select
                                    value={drawableMergeType}
                                    onChange={(e) =>
                                        setDrawableMergeType(e.target.value as PgnMergeType)
                                    }
                                    slotProps={{
                                        select: {
                                            renderValue: (value) =>
                                                mergeTypeLabels[value as PgnMergeType],
                                        },
                                    }}
                                    size='small'
                                    sx={{ minWidth: '140px' }}
                                >
                                    <MenuItem value={PgnMergeTypes.MERGE}>
                                        <ListItemText
                                            primary='Merge'
                                            secondary='Arrows and highlights will be combined'
                                        />
                                    </MenuItem>
                                    <MenuItem value={PgnMergeTypes.OVERWRITE}>
                                        <ListItemText
                                            primary='Overwrite'
                                            secondary='Arrows and highlights from later games overwrite earlier ones'
                                        />
                                    </MenuItem>
                                    <MenuItem value={PgnMergeTypes.DISCARD}>
                                        <ListItemText
                                            primary='Ignore'
                                            secondary='Arrows and highlights from non-header-source games are ignored'
                                        />
                                    </MenuItem>
                                </TextField>
                            </Stack>
                        </FormGroup>

                        <FormControlLabel
                            control={
                                <Checkbox
                                    checked={citeSource}
                                    onChange={(e) => setCiteSource(e.target.checked)}
                                />
                            }
                            label='Add source game citation to the end of each merged line'
                        />
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleClose} disabled={request.isLoading()}>
                        Cancel
                    </Button>
                    <LoadingButton loading={request.isLoading()} onClick={onMerge}>
                        Merge Games
                    </LoadingButton>
                </DialogActions>
            </Dialog>
        </>
    );
}
