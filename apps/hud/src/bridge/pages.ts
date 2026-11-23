import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk';
import { PADDING, type PageSpec, type TextSpec } from '../render/layout';
import type { BridgeQueue } from './queue';

/** The bridge methods the renderer uses (the real `EvenAppBridge` satisfies this). */
export type PageBridge = {
  createStartUpPageContainer(c: CreateStartUpPageContainer): Promise<number>;
  rebuildPageContainer(c: RebuildPageContainer): Promise<boolean>;
  textContainerUpgrade(c: TextContainerUpgrade): Promise<boolean>;
};

/** Contextual menu, carried on every rebuild (a rebuild without it clears the menu). */
export const MENU_ITEMS = [
  { itemName: 'Speak', itemID: 1 },
  { itemName: 'Cancel orders', itemID: 2 },
  { itemName: 'Refresh', itemID: 3 },
  { itemName: 'Mode info', itemID: 4 },
];

const MAX_UPGRADES = 2;

export type UpdatePlan =
  | { kind: 'none' }
  | { kind: 'upgrade'; texts: TextSpec[] }
  | { kind: 'rebuild' };

function sameGeometry(a: TextSpec, b: TextSpec): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.x === b.x &&
    a.y === b.y &&
    a.w === b.w &&
    a.h === b.h &&
    a.capture === b.capture &&
    JSON.stringify(a.border) === JSON.stringify(b.border)
  );
}

/** Same layout and at most two changed texts → in-place upgrades (no flicker); otherwise rebuild. */
export function planUpdate(prev: PageSpec | null, next: PageSpec): UpdatePlan {
  if (!prev || prev.layoutKey !== next.layoutKey) return { kind: 'rebuild' };
  if (prev.texts.length !== next.texts.length) return { kind: 'rebuild' };
  if (JSON.stringify(prev.list) !== JSON.stringify(next.list)) return { kind: 'rebuild' };
  const changed: TextSpec[] = [];
  for (let i = 0; i < next.texts.length; i++) {
    const a = prev.texts[i] as TextSpec;
    const b = next.texts[i] as TextSpec;
    if (!sameGeometry(a, b)) return { kind: 'rebuild' };
    if (a.text !== b.text || a.color !== b.color) changed.push(b);
  }
  if (changed.length === 0) return { kind: 'none' };
  return changed.length <= MAX_UPGRADES ? { kind: 'upgrade', texts: changed } : { kind: 'rebuild' };
}

function textProperty(t: TextSpec): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: t.x,
    yPosition: t.y,
    width: t.w,
    height: t.h,
    borderWidth: t.border?.width ?? 0,
    borderColor: t.border?.color ?? 0,
    borderRadius: t.border?.radius ?? 0,
    paddingLength: PADDING,
    containerID: t.id,
    containerName: t.name,
    content: t.text,
    textColor: t.color,
    isEventCapture: t.capture ? 1 : 0,
  });
}

function containers(spec: PageSpec) {
  const textObject = spec.texts.map(textProperty);
  const listObject = spec.list
    ? [
        new ListContainerProperty({
          xPosition: spec.list.x,
          yPosition: spec.list.y,
          width: spec.list.w,
          height: spec.list.h,
          borderWidth: 0,
          borderColor: 0,
          borderRadius: 0,
          paddingLength: PADDING,
          containerID: spec.list.id,
          containerName: spec.list.name,
          isEventCapture: 1,
          itemContainer: new ListItemContainerProperty({
            itemCount: spec.list.items.length,
            itemWidth: spec.list.w,
            isItemSelectBorderEn: 1,
            itemName: spec.list.items,
          }),
        }),
      ]
    : undefined;
  const menuObject = new MenuContainerProperty({
    menuItems: MENU_ITEMS.map((m) => new MenuItemProperty(m)),
  });
  return {
    containerTotalNum: textObject.length + (listObject?.length ?? 0),
    textObject,
    ...(listObject ? { listObject } : {}),
    menuObject,
  };
}

/**
 * Renders PageSpecs on the glasses. The startup page is created exactly once (a second create
 * blocks ~2 s and fails); after a refused or hung create every render rebuilds. Renders requested
 * while one is in flight collapse to the latest.
 */
export function createPageRenderer(
  bridge: PageBridge,
  queue: BridgeQueue,
  onTextUpdate: () => void,
) {
  let started = false;
  let shown: PageSpec | null = null;
  let pending: PageSpec | null = null;
  let inFlight: Promise<void> | null = null;

  async function apply(next: PageSpec): Promise<void> {
    if (!started) {
      started = true;
      try {
        const result = await queue.run(() =>
          bridge.createStartUpPageContainer(new CreateStartUpPageContainer(containers(next))),
        );
        shown = result === 0 ? next : null;
      } catch {
        shown = null; // a hung or failed startup call must not stop the HUD: rebuild next time
      }
      onTextUpdate();
      return;
    }
    const plan = planUpdate(shown, next);
    if (plan.kind === 'none') return;
    if (plan.kind === 'upgrade') {
      for (const t of plan.texts) {
        await queue.run(() =>
          bridge.textContainerUpgrade(
            new TextContainerUpgrade({
              containerID: t.id,
              containerName: t.name,
              content: t.text,
              textColor: t.color,
            }),
          ),
        );
      }
      shown = next;
    } else {
      const ok = await queue.run(() =>
        bridge.rebuildPageContainer(new RebuildPageContainer(containers(next))),
      );
      shown = ok ? next : null;
    }
    onTextUpdate();
  }

  async function drain(): Promise<void> {
    while (pending) {
      const next = pending;
      pending = null;
      try {
        await apply(next);
      } catch {
        shown = null; // unknown state on the glasses: force a rebuild on the next render
      }
    }
  }

  return {
    render(next: PageSpec): Promise<void> {
      pending = next;
      if (!inFlight) {
        inFlight = drain().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
  };
}
