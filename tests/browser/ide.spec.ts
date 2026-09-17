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
    const resize = page.getByRole('separator', { name: 'Resize bottom panel' });
    const initialHeight = await resize.getAttribute('aria-valuenow');
    await resize.press('ArrowUp');
    await expect(resize).not.toHaveAttribute('aria-valuenow', initialHeight ?? '');

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

  test('shows the operational deployment card, filters, and safe actions', async ({ page, request }) => {
    const migration = await request.post('/api/projects/project-local/migrate', { data: { dryRun: false } });
    expect(migration.ok()).toBeTruthy();
    const compile = await request.post('/api/projects/project-local/compile', { data: { environment: 'local' } });
    expect(compile.ok()).toBeTruthy();
    const artifact = await compile.json() as { id: string };
    const deployment = await request.post('/api/deployments', {
      data: { workflowId: 'workflow-agent-intake', environment: 'local', artifactId: artifact.id, trigger: 'manual' },
    });
    expect(deployment.ok()).toBeTruthy();

    await page.goto('/#/deployments');
    await expect(page.getByRole('heading', { name: 'Deployments' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Filter deployments by observed state' })).toBeVisible();
    const card = page.locator('article.connection-card').first();
    await expect(card).toContainText('workflow-agent-intake');
    await expect(card.getByText(/Health evidence/)).toBeVisible();
    await expect(card.getByText(/Recent runs/)).toBeVisible();
    await expect(card.getByText('Run logs', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Workspace' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Observe' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Filter deployments by observed state' }).selectOption('stopped');
    await expect(card).toBeVisible();
    await page.getByRole('combobox', { name: 'Filter deployments by observed state' }).selectOption('all');

    await card.getByRole('button', { name: 'Observe' }).click();
    await expect(page).toHaveURL(/#\/observe\?workflowId=workflow-agent-intake&environment=local/);
    await expect(page.getByRole('heading', { name: 'Observe' })).toBeVisible();

    await page.goto('/#/deployments');
    const refreshedCard = page.locator('article.connection-card').first();
    const source = refreshedCard.getByRole('button', { name: 'workflows/workflow-agent-intake.workflow.yaml' });
    await source.click();
    await expect(page).toHaveURL(/#\/studio$/);
    await expect(page.getByRole('heading', { name: 'Project definition' })).toBeVisible();
  });
});
