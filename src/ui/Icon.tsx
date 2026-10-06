/**
 * Vector icon (SF Symbols–style line art from ./icons) rendered with Skia, the app's only
 * drawing layer. Parsed paths are cached per SVG string. In Jest (no Skia runtime) a
 * same-sized placeholder is rendered.
 */
import React, { memo, useMemo } from 'react';
import { StyleProp, View, ViewStyle } from 'react-native';
import { ICONS, IconName, IconSpec } from './icons';
import { useTheme } from './ThemeProvider';

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

const pathCache = new Map<string, unknown>();
function parsePath(skia: SkiaModule, svg: string): unknown {
  let p = pathCache.get(svg);
  if (p === undefined) {
    p = skia.Skia.Path.MakeFromSVGString(svg) ?? null;
    pathCache.set(svg, p);
  }
  return p;
}

export interface IconProps {
  readonly name: IconName;
  readonly size?: number;
  /** Defaults to the theme's primary (tint) colour. */
  readonly color?: string;
  /** Stroke width on the 24-unit grid. */
  readonly weight?: number;
  /** Colour of knockout strokes drawn over filled shapes (default white). */
  readonly knockoutColor?: string;
  readonly style?: StyleProp<ViewStyle>;
}

export const Icon: React.FC<IconProps> = memo(
  ({ name, size = 24, color, weight = 1.8, knockoutColor = '#FFFFFF', style }) => {
    const { colors } = useTheme();
    const tint = color ?? colors.primary;
    const skia = loadSkia();
    const spec: IconSpec = ICONS[name];

    const paths = useMemo(() => {
      if (!skia) return null;
      const map = (list?: readonly string[]) =>
        (list ?? []).map((svg) => parsePath(skia, svg)).filter((p) => p !== null);
      return { s: map(spec.s), f: map(spec.f), k: map(spec.k) };
    }, [skia, spec]);

    const box: ViewStyle = { width: size, height: size };
    if (!skia || !paths) {
      return <View style={[box, style]} pointerEvents="none" importantForAccessibility="no" />;
    }
    const { Canvas, Group, Path } = skia;
    const scale = size / 24;
    return (
      <View style={[box, style]} pointerEvents="none" importantForAccessibility="no-hide-descendants">
        <Canvas style={box}>
          <Group transform={[{ scale }]}>
            {paths.f.map((p, i) => (
              <Path key={`f${i}`} path={p as never} color={tint} style="fill" />
            ))}
            {paths.s.map((p, i) => (
              <Path
                key={`s${i}`}
                path={p as never}
                color={tint}
                style="stroke"
                strokeWidth={weight}
                strokeCap="round"
                strokeJoin="round"
              />
            ))}
            {paths.k.map((p, i) => (
              <Path
                key={`k${i}`}
                path={p as never}
                color={knockoutColor}
                style="stroke"
                strokeWidth={weight + 0.2}
                strokeCap="round"
                strokeJoin="round"
              />
            ))}
          </Group>
        </Canvas>
      </View>
    );
  },
);
