import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk';
import type { BridgeQueue } from './queue';

/** The bridge methods the screen layer uses (the real `EvenAppBridge` satisfies this). */
export type ScreenBridge = {
  createStartUpPageContainer(c: CreateStartUpPageContainer): Promise<number>;
  rebuildPageContainer(c: RebuildPageContainer): Promise<boolean>;
  textContainerUpgrade(c: TextContainerUpgrade): Promise<boolean>;
};

const MAIN_ID = 1;
const MAIN_NAME = 'main';

function mainText(content: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: MAIN_ID,
    containerName: MAIN_NAME,
    content,
    isEventCapture: 1,
  });
}

/**
 * Single full-screen text page used until the card renderer takes over (Task 9). The startup page
 * may be created only once per session: a second call blocks ~2 s and fails, so after a refused
 * create every later render rebuilds instead.
 */
export function createMainScreen(
  bridge: ScreenBridge,
  queue: BridgeQueue,
  onTextUpdate: () => void,
) {
  let started = false;
  let startupOk = false;

  return {
    async start(content: string): Promise<boolean> {
      if (started) return startupOk;
      started = true;
      const result = await queue.run(() =>
        bridge.createStartUpPageContainer(
          new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [mainText(content)] }),
        ),
      );
      startupOk = result === 0;
      onTextUpdate();
      return startupOk;
    },

    async show(content: string): Promise<void> {
      if (startupOk) {
        await queue.run(() =>
          bridge.textContainerUpgrade(
            new TextContainerUpgrade({ containerID: MAIN_ID, containerName: MAIN_NAME, content }),
          ),
        );
      } else {
        startupOk = await queue.run(() =>
          bridge.rebuildPageContainer(
            new RebuildPageContainer({ containerTotalNum: 1, textObject: [mainText(content)] }),
          ),
        );
      }
      onTextUpdate();
    },
  };
}
