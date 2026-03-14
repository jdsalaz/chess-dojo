'use strict';

import { MergeMultipleSchema } from '@jackstenglein/chess-dojo-common/src/pgn/merge';
import { describe, expect, test } from 'vitest';

/** Helper to build a game key with a unique id. */
function gameKey(index: number) {
    return { cohort: '2000-2100', id: `2025-01-01_game${index}` };
}

describe('MergeMultipleSchema', () => {
    test('rejects fewer than 2 games', () => {
        const result = MergeMultipleSchema.safeParse({
            games: [gameKey(1)],
            headerSource: gameKey(1),
        });
        expect(result.success).toBe(false);
    });

    test('accepts exactly 2 games', () => {
        const result = MergeMultipleSchema.safeParse({
            games: [gameKey(1), gameKey(2)],
            headerSource: gameKey(1),
        });
        expect(result.success).toBe(true);
    });

    test('accepts exactly 20 games', () => {
        const games = Array.from({ length: 20 }, (_, i) => gameKey(i + 1));
        const result = MergeMultipleSchema.safeParse({
            games,
            headerSource: games[0],
        });
        expect(result.success).toBe(true);
    });

    test('rejects more than 20 games', () => {
        const games = Array.from({ length: 21 }, (_, i) => gameKey(i + 1));
        const result = MergeMultipleSchema.safeParse({
            games,
            headerSource: games[0],
        });
        expect(result.success).toBe(false);
    });

    test('rejects duplicate cohort/id pairs', () => {
        const result = MergeMultipleSchema.safeParse({
            games: [gameKey(1), gameKey(1)],
            headerSource: gameKey(1),
        });
        expect(result.success).toBe(false);
    });
});
