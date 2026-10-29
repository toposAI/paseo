import { expect, test as base } from "../support/fixtures";
import {
  createSettledMockAgent,
  emitSettledAssistantImage,
} from "../support/helpers/assistant-images";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

/**
 * Local chat images still travel through the daemon, never the device.
 *
 * A `.invalid` host can never resolve. If the renderer treated the remote URL
 * like the old "direct" case the browser would still issue a request for it;
 * through the daemon proxy the fetch fails first and the image is reported
 * unavailable instead.
 */
const UNREACHABLE_IMAGE_URL = "https://chat-image.invalid/product.png";

const test = base.extend<{ chatImageWorkspace: SeededWorkspace }>({
  chatImageWorkspace: async ({ page: _page }, provide) => {
    const workspace = await seedWorkspace({ repoPrefix: "chat-images-proxy-" });
    try {
      await provide(workspace);
    } finally {
      await workspace.cleanup();
    }
  },
});

test("a remote chat image is fetched by the daemon, not by the device", async ({
  chatImageWorkspace: workspace,
  page,
}) => {
  test.setTimeout(120_000);
  const imageRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://chat-image.invalid")) {
      imageRequests.push(request.url());
    }
  });

  const agent = await createSettledMockAgent(workspace, "Remote chat image");
  await emitSettledAssistantImage(workspace.client, agent, {
    alt: "商品画像",
    height: 1,
    relativePath: UNREACHABLE_IMAGE_URL,
    size: 0,
    width: 1,
  });
  await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.id });

  // The daemon refuses the unreachable host, and the message says so instead of
  // leaving a broken image behind.
  await expect(page.getByText("画像が利用できません").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_500);
  expect(imageRequests).toEqual([]);
});
