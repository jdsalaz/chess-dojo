import { expect, test } from '@playwright/test';
import { getEnv } from '../../../../lib/env';
import { interceptApi } from '../../../../lib/helpers';

/**
 * Navigate to the current user's profile games page with the "All Uploads"
 * directory, which shows checkbox selection and the BulkGameEditor bar.
 */
async function goToMyUploads(page: import('@playwright/test').Page) {
    const username = getEnv('username');
    await page.goto(`/profile/${username}?view=games&directory=uploads`);
    await expect(page.getByTestId('games-table')).toBeVisible();
    // Wait for the hidden content measurement area to disappear
    await expect(
        page.getByTestId('games-table').locator('.MuiDataGrid-main--hiddenContent'),
    ).toHaveCount(0);
}

/**
 * Returns all visible DataGrid row checkboxes.
 */
function getRowCheckboxes(page: import('@playwright/test').Page) {
    return page
        .getByTestId('games-table')
        .locator(
            '.MuiDataGrid-main:not(.MuiDataGrid-main--hiddenContent) .MuiDataGrid-row input[type="checkbox"]',
        );
}

test.describe('Merge Games', () => {
    test('shows Merge Games action when 2+ games are selected', async ({ page }) => {
        await goToMyUploads(page);

        const checkboxes = getRowCheckboxes(page);
        await expect(checkboxes.first()).toBeVisible();

        // Select first game — merge should NOT appear (need 2+)
        await checkboxes.nth(0).click();
        await expect(page.getByText(/1 selected/)).toBeVisible();
        await expect(page.getByRole('button', { name: 'Merge Games' })).toBeHidden();

        // Select second game — merge SHOULD appear
        await checkboxes.nth(1).click();
        await expect(page.getByText(/2 selected/)).toBeVisible();
        await expect(page.getByRole('button', { name: 'Merge Games' })).toBeVisible();
    });

    test('opens MergeGamesDialog and shows selected games', async ({ page }) => {
        await goToMyUploads(page);

        const checkboxes = getRowCheckboxes(page);
        await checkboxes.nth(0).click();
        await checkboxes.nth(1).click();
        await expect(page.getByText(/2 selected/)).toBeVisible();

        // Open the merge dialog
        await page.getByRole('button', { name: 'Merge Games' }).click();

        // Verify dialog is open with correct title
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText('Merge 2 Games')).toBeVisible();

        // Verify "Selected Games" section lists games
        await expect(dialog.getByText('Selected Games')).toBeVisible();
        // Each game should be listed with a number prefix (1. and 2.)
        await expect(dialog.getByText(/^1\.\s/)).toBeVisible();
        await expect(dialog.getByText(/^2\.\s/)).toBeVisible();
    });

    test('shows merge options in dialog', async ({ page }) => {
        await goToMyUploads(page);

        const checkboxes = getRowCheckboxes(page);
        await checkboxes.nth(0).click();
        await checkboxes.nth(1).click();
        await page.getByRole('button', { name: 'Merge Games' }).click();

        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();

        // Verify "Use headers from" dropdown
        await expect(dialog.getByText('Use headers from')).toBeVisible();

        // Verify merge options section
        await expect(dialog.getByText('Merge Options')).toBeVisible();
        await expect(dialog.getByText('Comments')).toBeVisible();
        await expect(dialog.getByText('Glyphs')).toBeVisible();
        await expect(dialog.getByText('Arrows/Highlights')).toBeVisible();

        // Verify cite source checkbox
        await expect(
            dialog.getByText('Add source game citation to the end of each merged line'),
        ).toBeVisible();

        // Verify action buttons
        await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Merge Games' })).toBeVisible();
    });

    test('merge button calls API and opens new tab on success', async ({ page, context }) => {
        await goToMyUploads(page);

        const checkboxes = getRowCheckboxes(page);
        await checkboxes.nth(0).click();
        await checkboxes.nth(1).click();
        await page.getByRole('button', { name: 'Merge Games' }).click();

        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();

        // Mock the merge API to return a successful response
        await interceptApi(page, 'POST', '/game/merge-multiple', {
            body: { cohort: '1500-1600', id: '2024.01.01_merged-test-game' },
        });

        // Listen for the new tab that will open
        const newPagePromise = context.waitForEvent('page');

        // Click merge
        await dialog.getByRole('button', { name: 'Merge Games' }).click();

        // Verify new tab opens with the merged game URL
        const newPage = await newPagePromise;
        expect(newPage.url()).toContain('/games/1500-1600/2024.01.01_merged-test-game');
    });

    test('cancel closes the dialog without merging', async ({ page }) => {
        await goToMyUploads(page);

        const checkboxes = getRowCheckboxes(page);
        await checkboxes.nth(0).click();
        await checkboxes.nth(1).click();
        await page.getByRole('button', { name: 'Merge Games' }).click();

        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();

        // Cancel
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();

        // Bulk editor should still be visible with games selected
        await expect(page.getByText(/2 selected/)).toBeVisible();
    });

    test('hides merge action when fewer than 2 games are selected', async ({ page }) => {
        await goToMyUploads(page);

        const checkboxes = getRowCheckboxes(page);

        // Select 2 games first
        await checkboxes.nth(0).click();
        await checkboxes.nth(1).click();
        await expect(page.getByRole('button', { name: 'Merge Games' })).toBeVisible();

        // Deselect one — merge should hide
        await checkboxes.nth(1).click();
        await expect(page.getByText(/1 selected/)).toBeVisible();
        await expect(page.getByRole('button', { name: 'Merge Games' })).toBeHidden();
    });
});

test.describe('Merge Games (viewing another user)', () => {
    test('hides merge action when viewing another user games', async ({ page }) => {
        // Navigate to a different user's profile games page.
        // The ListItemContextMenu is used here without allowEdits, and the
        // BulkGameEditor bar is not rendered (checkbox selection is disabled
        // when currentUser !== profile owner).
        // We verify that the checkbox selection column is not present.
        await page.goto('/profile/JackStenglein?view=games&directory=uploads');
        await expect(page.getByTestId('games-table')).toBeVisible();
        await expect(
            page.getByTestId('games-table').locator('.MuiDataGrid-main--hiddenContent'),
        ).toHaveCount(0);

        // Verify no checkbox column exists in the DataGrid
        const checkboxes = page
            .getByTestId('games-table')
            .locator(
                '.MuiDataGrid-main:not(.MuiDataGrid-main--hiddenContent) .MuiDataGrid-columnHeader--checkbox',
            );
        await expect(checkboxes).toHaveCount(0);
    });
});
