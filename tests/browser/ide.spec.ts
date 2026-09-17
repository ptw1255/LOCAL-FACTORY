import { expect, test } from '@playwright/test';

test.describe('IDE workspace', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/studio');
    await expect(page.getByRole('heading', { name: 'Project definition' })).toBeVisible();
  });

  test('keeps files, tree, canvas, editor, and output discoverable', async ({ page }) => {
    const view = page.getByRole('combobox', { name: 'Workspace view' });
    await expect(view).toHaveValue('files');
    await expect(page.getByRole('tab', { name: /Problems/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Run Output/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Collapse bottom panel' })).toBeVisible();

    await view.selectOption('tree');
    await expect(page.getByText('Operational tree', { exact: true })).toBeVisible();
    await view.selectOption('canvas');
    await expect(page.getByText('Node palette', { exact: true })).toBeVisible();
  });

  test('opens and closes the command palette with the platform shortcut', async ({ page }) => {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+P' : 'Control+P');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Search commands and files' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});

test.describe('Observe and Deployments', () => {
  test('exposes telemetry tabs and retention policy', async ({ page }) => {
    await page.goto('/#/observe');
    await expect(page.getByRole('heading', { name: 'Observe' })).toBeVisible();
    await expect(page.getByText(/Telemetry retention:.*48 hours/)).toBeVisible();
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(4);
    await page.getByRole('tab', { name: 'Metrics' }).click();
    await expect(page.getByRole('tab', { name: 'Metrics' })).toHaveAttribute('aria-selected', 'true');
  });

  test('shows the operational deployment screen and safe empty state', async ({ page }) => {
    await page.goto('/#/deployments');
    await expect(page.getByRole('heading', { name: 'Deployments' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Filter deployments by observed state' })).toBeVisible();
    await expect(page.getByText('No deployments yet', { exact: true })).toBeVisible();
  });
});
