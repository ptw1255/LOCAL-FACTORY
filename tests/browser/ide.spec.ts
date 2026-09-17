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

  test('opens Run preflight for workflows with required input and restores focus', async ({ page, request }) => {
    const workflowResponse = await request.get('/api/workflows/workflow-agent-intake');
    expect(workflowResponse.ok()).toBeTruthy();
    const workflow = await workflowResponse.json() as Record<string, unknown>;
    workflow.inputSchema = { type: 'object', required: ['request'], properties: { request: { type: 'string' } } };
    const saved = await request.put('/api/workflows/workflow-agent-intake', { data: workflow });
    expect(saved.ok()).toBeTruthy();

    await page.reload();
    const runButton = page.getByRole('button', { name: 'Run', exact: true });
    await runButton.click();
    const dialog = page.getByRole('dialog', { name: 'Workflow run input' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog.getByRole('button', { name: 'Close run input' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(runButton).toBeFocused();
  });

  test('persists semantic Canvas edits to workflow and WorkUnit modules', async ({ page, request }) => {
    const migration = await request.post('/api/projects/project-local/migrate', { data: { dryRun: false } });
    expect(migration.ok()).toBeTruthy();
    const compile = await request.post('/api/projects/project-local/compile', { data: { environment: 'local' } });
    expect(compile.ok()).toBeTruthy();

    const view = page.getByRole('combobox', { name: 'Workspace view' });
    await view.selectOption('canvas');
    const transform = page.locator('button.palette-item').filter({ hasText: 'Transform' }).first();
    await expect(transform).toBeVisible();
    await transform.click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.toast').filter({ hasText: 'Saved version' })).toBeVisible();

    const workflowFile = await request.get('/api/projects/project-local/files?path=workflows/workflow-agent-intake.workflow.yaml');
    expect(workflowFile.ok()).toBeTruthy();
    const workflowSource = await workflowFile.json() as { content: string };
    expect(workflowSource.content).toContain('type: transform');
    const files = await request.get('/api/projects/project-local/files');
    expect(files.ok()).toBeTruthy();
    const listing = await files.json() as { items: Array<{ path: string }> };
    expect(listing.items.some((file) => file.path.match(/^units\/unit-workflow-agent-intake-transform-/))).toBeTruthy();

    const workflows = await request.get('/api/workflows');
    expect(workflows.ok()).toBeTruthy();
    const current = await workflows.json() as { items: Array<{ id: string; nodes: Array<{ type: string }> }> };
    expect(current.items.find((item) => item.id === 'workflow-agent-intake')?.nodes.some((node) => node.type === 'transform')).toBeTruthy();
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

  test('opens a completed run with correlated timeline and signal tabs', async ({ page, request }) => {
    const workflowResponse = await request.get('/api/workflows/workflow-agent-intake');
    expect(workflowResponse.ok()).toBeTruthy();
    const workflow = await workflowResponse.json() as Record<string, any>;
    workflow.agents = [];
    workflow.nodes = workflow.nodes.filter((node: { type: string }) => ['manualTrigger', 'output'].includes(node.type));
    workflow.edges = [{ id: 'e-trigger-output', source: 'trigger', target: 'output' }];
    const saved = await request.put('/api/workflows/workflow-agent-intake', { data: workflow });
    expect(saved.ok()).toBeTruthy();

    const started = await request.post('/api/workflows/workflow-agent-intake/runs', {
      data: { environment: 'local', input: { request: 'Observe browser fixture' } },
    });
    expect(started.ok()).toBeTruthy();
    const run = await started.json() as { id: string };
    await expect.poll(async () => {
      const response = await request.get(`/api/runs/${run.id}`);
      return (await response.json() as { status: string }).status;
    }, { timeout: 10_000 }).toBe('succeeded');

    await page.goto(`/#/observe?runId=${encodeURIComponent(run.id)}`);
    await expect(page.getByRole('heading', { name: 'Observe' })).toBeVisible();
    await expect(page.getByText('Event timeline', { exact: true })).toBeVisible();
    await expect(page.locator('.run-trace-reference')).toBeVisible();
    await page.getByRole('tab', { name: 'Logs' }).click();
    await expect(page.getByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true');
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
    await expect(refreshedCard).toBeVisible();
    const source = refreshedCard.getByTitle('Open workflows/workflow-agent-intake.workflow.yaml');
    await source.click();
    await expect(page).toHaveURL(/#\/studio$/);
    await expect(page.getByRole('heading', { name: 'Project definition' })).toBeVisible();
  });
});
