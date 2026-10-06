/**
 * Draws markup path commands with Skia (live ink preview, signature thumbnails, PDF markup
 * preview). Coordinates are multiplied by `scale`. Renders nothing in Jest.
 */
import React, { memo, useMemo } from 'react';
import { View } from 'react-native';
import { PathCommand, commandsToSvg } from '../../features/markup/inkPath';

declare const process: any;

type SkiaModule = typeof import('@shopify/react-native-skia');
let skiaModule: SkiaModule | null | undefined;
function loadSkia(): SkiaModule | null {
  if (skiaModule === undefined) {
    if (typeof process !== 'undefined' && process?.env?.NODE_ENV === 'test') {
      skiaModule = null;
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        skiaModule = require('@shopify/react-native-skia') as SkiaModule;
      } catch {
        skiaModule = null;
      }
    }
  }
  return skiaModule;
}

export interface InkItem {
  readonly key: string;
  readonly commands: readonly PathCommand[];
  readonly color: string;
  readonly width: number;
  readonly opacity?: number;
  /** Highlighter strokes multiply with the page underneath. */
  readonly multiply?: boolean;
  /** Filled shape (e.g. text highlight rectangles). */
  readonly fill?: boolean;
}

export const InkLayer: React.FC<{
  items: readonly InkItem[];
  width: number;
  height: number;
  scale?: number;
}> = memo(({ items, width, height, scale = 1 }) => {
  const skia = loadSkia();
  const paths = useMemo(() => {
    if (!skia) return [];
    return items
      .map((item) => {
        const path = skia.Skia.Path.MakeFromSVGString(commandsToSvg(item.commands));
        return path ? { item, path } : null;
      })
      .filter((p): p is { item: InkItem; path: NonNullable<ReturnType<typeof skia.Skia.Path.MakeFromSVGString>> } => p !== null);
  }, [skia, items]);

  if (!skia || width <= 0 || height <= 0) return <View style={{ width, height }} pointerEvents="none" />;
  const { Canvas, Group, Path } = skia;
  return (
    <Canvas style={{ width, height }} pointerEvents="none">
      <Group transform={[{ scale }]}>
        {paths.map(({ item, path }) => (
          <Path
            key={item.key}
            path={path}
            color={item.color}
            opacity={item.opacity ?? 1}
            style={item.fill ? 'fill' : 'stroke'}
            strokeWidth={item.width}
            strokeCap="round"
            strokeJoin="round"
            blendMode={item.multiply ? 'multiply' : 'srcOver'}
          />
        ))}
      </Group>
    </Canvas>
  );
});
