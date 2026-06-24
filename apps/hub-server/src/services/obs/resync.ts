import type { OBSClient } from "./client.js";

export async function resyncOBS(client: OBSClient, desiredScene: string): Promise<void> {
  if (!client.isConnected()) return;
  const currentScene = await client.getCurrentScene();
  if (currentScene !== desiredScene) {
    await client.switchScene(desiredScene);
  }
}
