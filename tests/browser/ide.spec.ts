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
    const explorerResize = page.getByRole('separator', { name: 'Resize explorer' });
    const initialWidth = await explorerResize.getAttribute('aria-valuenow');
    await explorerResize.press('ArrowRight');
    await expect(explorerResize).not.toHaveAttribute('aria-valuenow', initialWidth ?? '');

    await view.selectOption('tree');
    await expect(page.getByText('Operational tree', { exact: true })).toBeVisible();
    await view.selectOption('canvas');
    await expect(page.getByText('Node palette', { exact: true })).toBeVisible();
  });

  test('announces workspace status and keeps status badges readable', async ({ page }) => {
    const status = page.locator('[role="status"]').first();
    await expect(status).toBeVisible();
    await expect(status).toContainText(/Quick start|Preparing|Project definition/);

    const contrastRatios = await page.locator('.status-badge').evaluateAll((badges) => badges.map((badge) => {
      const parse = (value: string): [number, number, number] => {
        const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        return match === null ? [0, 0, 0] : [Number(match[1]), Number(match[2]), Number(match[3])];
      };
      const luminance = (value: [number, number, number]): number => value.reduce((sum, channel, index) => {
        const normalized = channel / 255;
        return sum + (normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index]!;
      }, 0);
      const style = getComputedStyle(badge);
      const foreground = luminance(parse(style.color));
      const background = luminance(parse(style.backgroundColor));
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    }));
    expect(contrastRatios.length).toBeGreaterThan(0);
    for (const ratio of contrastRatios) expect(ratio).toBeGreaterThanOrEqual(3);
  });

  test('opens, reorders, closes, and restores file-backed editor tabs', async ({ page, request }) => {
    const migration = await request.post('/api/projects/project-local/migrate', { data: { dryRun: false } });
    expect(migration.ok()).toBeTruthy();
    const listingResponse = await request.get('/api/projects/project-local/files');
    expect(listingResponse.ok()).toBeTruthy();
    const listing = await listingResponse.json() as { items: Array<{ path: string }> };
    const paths = listing.items.map((file) => file.path).filter((path) => path.endsWith('.yaml')).slice(0, 2);
    expect(paths).toHaveLength(2);
    const tabs = page.locator('.ide-tabs').getByRole('tab');
    for (const filePath of paths) {
      await page.locator('button.ide-file').filter({ hasText: filePath }).first().click();
    }
    const defaultTabClose = page.getByRole('button', { name: 'Close project.yaml' });
    if (await defaultTabClose.count() > 0) await defaultTabClose.click();
    await expect(tabs).toHaveCount(2);
    const activeTab = tabs.filter({ hasText: paths[1]! }).first();
    await activeTab.click();
    await expect(activeTab).toHaveAttribute('aria-selected', 'true');
    await activeTab.press('ArrowLeft');
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
    const reordered = await tabs.allTextContents();
    expect(reordered[0]).toContain(paths[1]!);
    expect(reordered[1]).toContain(paths[0]!);
    await page.getByRole('button', { name: `Close ${paths[1]!}` }).click();
    await expect(tabs).toHaveCount(1);
    await page.reload();
    await expect(page.locator('.ide-tabs').getByRole('tab')).toHaveCount(1);
    await expect(page.locator('.ide-tabs').getByRole('tab').first()).toContainText(paths[0]!);
  });

  test('opens and closes the command palette with the platform shortcut', async ({ page }) => {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+P' : 'Control+P');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Search commands and files' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('navigates the application shell with keyboard-only controls', async ({ page }) => {
    const observe = page.getByRole('button', { name: 'Observe', exact: true });
    await observe.focus();
    await expect(observe).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/observe$/);
    await expect(page.getByRole('heading', { name: 'Observe' })).toBeVisible();

    const workspace = page.getByRole('button', { name: 'Workspace', exact: true });
    await workspace.focus();
    await expect(workspace).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/studio$/);
    await expect(page.getByRole('heading', { name: 'Project definition' })).toBeVisible();
  });

  test('navigates bottom panel tabs with roving keyboard focus', async ({ page }) => {
    const problems = page.getByRole('tab', { name: /Problems/ });
    const output = page.getByRole('tab', { name: /Run Output/ });
    await problems.focus();
    await page.keyboard.press('ArrowRight');
    await expect(output).toBeFocused();
    await expect(output).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(problems).toBeFocused();
    await expect(problems).toHaveAttribute('aria-selected', 'true');
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
    const view = page.getByRole('combobox', { name: 'Workspace view' });
    await view.selectOption('canvas');
    const transform = page.locator('button.palette-item').filter({ hasText: 'Transform' }).first();
    await expect(transform).toBeVisible();
    await transform.click();
    const transformNodes = page.locator('.react-flow__node article.workflow-node').filter({ hasText: 'Transform' });
    await expect(transformNodes.last()).toHaveCount(1);
    const transformCountAfterAdd = await transformNodes.count();
    await page.getByRole('button', { name: 'Undo Canvas edit' }).click();
    await expect(transformNodes).toHaveCount(transformCountAfterAdd - 1);
    await page.getByRole('button', { name: 'Redo Canvas edit' }).click();
    await expect(transformNodes).toHaveCount(transformCountAfterAdd);
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

    const addedNode = page.locator('.react-flow__node article.workflow-node').filter({ hasText: 'Transform' }).last();
    await expect(addedNode).toHaveCount(1);
    await addedNode.dispatchEvent('dblclick');
    await expect(page).toHaveURL(/#\/studio\?file=workflows%2Fworkflow-agent-intake\.workflow\.yaml/);
    await expect(page.getByRole('tab', { name: /workflows\/workflow-agent-intake\.workflow\.yaml/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.cdr.source-selection-highlight')).toHaveCount(1);
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
      data: { workflowId: 'workflow-agent-intake', environment: 'local', artifactId: artifact.id, trigger: 'webhook' },
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
    const webhookCard = page.locator('article.connection-card').filter({ hasText: 'webhook' }).first();
    await expect(webhookCard.getByLabel(/Trigger (not )?listening/)).toBeVisible();
    await page.getByRole('combobox', { name: 'Filter deployments by observed state' }).selectOption('stopped');
    await expect(card).toBeVisible();
    await page.getByRole('combobox', { name: 'Filter deployments by observed state' }).selectOption('all');

    // Exercise the operational lifecycle rather than only rendering its
    // controls. Start is immediate for the local runtime adapter; Stop has an
    // explicit confirmation boundary before the desired state changes.
    const startResponse = page.waitForResponse((response) => response.url().includes('/api/deployments/') && response.url().endsWith('/action') && response.request().method() === 'POST');
    await card.getByRole('button', { name: 'Start', exact: true }).dispatchEvent('click');
    await expect((await startResponse).status()).toBe(200);
    await expect.poll(async () => {
      const response = await request.get('/api/deployments');
      const items = await response.json() as { items: Array<{ desiredState: string; observedState: string }> };
      return items.items[0] === undefined ? '' : `${items.items[0].desiredState}:${items.items[0].observedState}`;
    }).toBe('running:live');
    await page.reload();
    const liveCard = page.locator('article.connection-card').first();
    await expect(liveCard.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    page.once('dialog', (dialog) => void dialog.accept());
    await liveCard.getByRole('button', { name: 'Stop', exact: true }).dispatchEvent('click');
    await expect.poll(async () => {
      const response = await request.get('/api/deployments');
      const items = await response.json() as { items: Array<{ desiredState: string; observedState: string }> };
      return items.items[0] === undefined ? '' : `${items.items[0].desiredState}:${items.items[0].observedState}`;
    }).toBe('stopped:stopped');

    await card.getByRole('button', { name: 'Observe' }).click();
    await expect(page).toHaveURL(/#\/observe\?(?:runId=[^&]+&)?workflowId=workflow-agent-intake&environment=local/);
    await expect(page.getByRole('heading', { name: 'Observe' })).toBeVisible();

    await page.getByRole('button', { name: 'Deployments', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Deployments' })).toBeVisible();
    const refreshedCard = page.locator('article.connection-card').first();
    await expect(refreshedCard).toBeVisible();
    const source = refreshedCard.getByTitle('Open workflows/workflow-agent-intake.workflow.yaml');
    await source.click();
    await expect(page).toHaveURL(/#\/studio$/);
    await expect(page.getByRole('heading', { name: 'Project definition' })).toBeVisible();
  });
});
