import type { TokenId } from "./ids.js";
import {
  isTokenReference,
  type DesignDocument,
  type DesignNode,
  type DesignToken,
  type LayoutMode,
  type NodeLayout,
  type NodeStyle,
  type NumberValue,
  type StringValue,
} from "./model.js";

export type CssStyle = Record<string, string | number>;

type TokenSource = DesignDocument | Record<string, DesignToken>;

function tokensFrom(source: TokenSource): Record<string, DesignToken> {
  return (source as DesignDocument).schema_version === 1
    ? (source as DesignDocument).tokens
    : (source as Record<string, DesignToken>);
}

export function resolveTokenValue(
  value: StringValue | NumberValue | DesignNode["style"]["fill"],
  source: TokenSource,
): string | number | undefined {
  if (!isTokenReference(value)) return value;
  const token = tokensFrom(source)[value.token_id];
  return token?.archived === false ? token.value : undefined;
}

function cssNumber(value: NumberValue | undefined, source: TokenSource, suffix = "px"): string | undefined {
  if (value === undefined) return undefined;
  const resolved = resolveTokenValue(value, source);
  if (typeof resolved === "number") return `${resolved}${suffix}`;
  if (typeof resolved === "string") return resolved;
  return undefined;
}

function cssString(value: StringValue | undefined, source: TokenSource): string | undefined {
  if (value === undefined) return undefined;
  const resolved = resolveTokenValue(value, source);
  return resolved === undefined ? undefined : String(resolved);
}

function assign(style: CssStyle, property: string, value: string | number | undefined): void {
  if (value !== undefined) style[property] = value;
}

const ARABIC_SCRIPT = /[\u0600-\u06ff\u0750-\u077f\u0870-\u089f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/u;

/**
 * Keep the canonical font value editable while making the two bundled
 * families a deterministic fallback stack. Persian/Arabic text prefers
 * Vazirmatn even when a legacy node still declares Inter.
 */
export function textFontFamilyStack(declaredFamily: string, content: string): string {
  const family = declaredFamily.trim();
  const normalized = family.toLocaleLowerCase();
  const containsArabicScript = ARABIC_SCRIPT.test(content);
  if (normalized === "vazirmatn" || normalized === "vazirmatn variable") {
    return "Vazirmatn, Inter, system-ui, sans-serif";
  }
  if (normalized === "inter" || normalized === "inter variable") {
    return containsArabicScript
      ? "Vazirmatn, Inter, system-ui, sans-serif"
      : "Inter, Vazirmatn, system-ui, sans-serif";
  }
  if (!family) {
    return containsArabicScript
      ? "Vazirmatn, Inter, system-ui, sans-serif"
      : "Inter, Vazirmatn, system-ui, sans-serif";
  }
  return containsArabicScript
    ? `${family}, Vazirmatn, Inter, system-ui, sans-serif`
    : `${family}, Inter, Vazirmatn, system-ui, sans-serif`;
}

export function layoutToCss(
  layout: NodeLayout,
  source: TokenSource,
  options: { parentLayoutMode?: LayoutMode; includePosition?: boolean } = {},
): CssStyle {
  const style: CssStyle = {};
  const includePosition = options.includePosition ?? true;
  const positionedByCoordinates = options.parentLayoutMode === undefined || options.parentLayoutMode === "absolute";

  if (includePosition) {
    style.position = positionedByCoordinates ? "absolute" : "relative";
    if (positionedByCoordinates) {
      style.left = `${layout.x}px`;
      style.top = `${layout.y}px`;
    }
  }

  style.width = layout.width_sizing === "fill" ? "100%" : layout.width_sizing === "hug" ? "fit-content" : `${layout.width}px`;
  style.height =
    layout.height_sizing === "fill" ? "100%" : layout.height_sizing === "hug" ? "fit-content" : `${layout.height}px`;
  assign(style, "minWidth", layout.min_width === undefined ? undefined : `${layout.min_width}px`);
  assign(style, "maxWidth", layout.max_width === undefined ? undefined : `${layout.max_width}px`);
  assign(style, "minHeight", layout.min_height === undefined ? undefined : `${layout.min_height}px`);
  assign(style, "maxHeight", layout.max_height === undefined ? undefined : `${layout.max_height}px`);

  if (layout.rotation !== undefined && layout.rotation !== 0) style.transform = `rotate(${layout.rotation}deg)`;

  if (layout.mode === "horizontal" || layout.mode === "vertical") {
    style.display = "flex";
    style.flexDirection = layout.mode === "horizontal" ? "row" : "column";
    assign(style, "gap", cssNumber(layout.gap, source));
    assign(style, "rowGap", cssNumber(layout.row_gap, source));
    assign(style, "columnGap", cssNumber(layout.column_gap, source));
    if (layout.wrap !== undefined) style.flexWrap = layout.wrap ? "wrap" : "nowrap";
  } else if (layout.mode === "grid") {
    style.display = "grid";
    style.gridTemplateColumns = `repeat(${layout.columns ?? 1}, minmax(0, 1fr))`;
    assign(style, "gap", cssNumber(layout.gap, source));
    assign(style, "rowGap", cssNumber(layout.row_gap, source));
    assign(style, "columnGap", cssNumber(layout.column_gap, source));
  }

  if (layout.padding !== undefined) {
    if (isTokenReference(layout.padding) || typeof layout.padding === "number") {
      assign(style, "padding", cssNumber(layout.padding, source));
    } else {
      const top = cssNumber(layout.padding.top, source) ?? "0";
      const right = cssNumber(layout.padding.right, source) ?? "0";
      const bottom = cssNumber(layout.padding.bottom, source) ?? "0";
      const left = cssNumber(layout.padding.left, source) ?? "0";
      style.padding = `${top} ${right} ${bottom} ${left}`;
    }
  }
  if (layout.align_items !== undefined) {
    style.alignItems = layout.align_items === "start" || layout.align_items === "end" ? `flex-${layout.align_items}` : layout.align_items;
  }
  if (layout.justify_content !== undefined) {
    style.justifyContent =
      layout.justify_content === "start" || layout.justify_content === "end"
        ? `flex-${layout.justify_content}`
        : layout.justify_content;
  }

  return style;
}

export function styleToCss(style: NodeStyle, source: TokenSource): CssStyle {
  const css: CssStyle = {};
  assign(css, "backgroundColor", cssString(style.fill, source));
  assign(css, "color", cssString(style.color, source));
  const opacity = style.opacity === undefined ? undefined : resolveTokenValue(style.opacity, source);
  if (typeof opacity === "number") css.opacity = opacity;

  if (style.border !== undefined) {
    const width = cssNumber(style.border.width, source) ?? "0";
    const color = cssString(style.border.color, source) ?? "transparent";
    css.border = `${width} ${style.border.style} ${color}`;
  }
  if (style.radius !== undefined) {
    if (typeof style.radius === "number" || isTokenReference(style.radius)) {
      assign(css, "borderRadius", cssNumber(style.radius, source));
    } else {
      css.borderRadius = [
        cssNumber(style.radius.top_left, source) ?? "0",
        cssNumber(style.radius.top_right, source) ?? "0",
        cssNumber(style.radius.bottom_right, source) ?? "0",
        cssNumber(style.radius.bottom_left, source) ?? "0",
      ].join(" ");
    }
  }
  if (style.shadows !== undefined) {
    css.boxShadow = style.shadows
      .map((shadow) => {
        const x = cssNumber(shadow.x, source) ?? "0";
        const y = cssNumber(shadow.y, source) ?? "0";
        const blur = cssNumber(shadow.blur, source) ?? "0";
        const spread = cssNumber(shadow.spread, source) ?? "0";
        const color = cssString(shadow.color, source) ?? "transparent";
        return `${shadow.inset === true ? "inset " : ""}${x} ${y} ${blur} ${spread} ${color}`;
      })
      .join(", ");
  }
  if (style.typography !== undefined) {
    assign(css, "fontFamily", cssString(style.typography.font_family, source));
    assign(css, "fontSize", cssNumber(style.typography.font_size, source));
    const fontWeight =
      style.typography.font_weight === undefined
        ? undefined
        : isTokenReference(style.typography.font_weight)
          ? resolveTokenValue(style.typography.font_weight, source)
          : style.typography.font_weight;
    assign(css, "fontWeight", fontWeight);
    if (style.typography.line_height === "normal") css.lineHeight = "normal";
    else assign(css, "lineHeight", cssNumber(style.typography.line_height, source));
    assign(css, "letterSpacing", cssNumber(style.typography.letter_spacing, source));
    assign(css, "textAlign", style.typography.text_align);
    assign(css, "textDecoration", style.typography.text_decoration);
    assign(css, "textTransform", style.typography.text_transform);
    assign(css, "fontStyle", style.typography.font_style);
  }
  assign(css, "overflow", style.overflow);
  assign(css, "objectPosition", style.object_position);
  assign(css, "cursor", style.cursor);
  assign(css, "pointerEvents", style.pointer_events);
  return css;
}

export function nodeToCss(
  node: DesignNode,
  document: DesignDocument,
  options: { parentLayoutMode?: LayoutMode; includePosition?: boolean } = {},
): CssStyle {
  const css = { ...layoutToCss(node.layout, document, options), ...styleToCss(node.style, document) };
  if (node.type === "text" && typeof css.fontFamily === "string") {
    css.fontFamily = textFontFamilyStack(css.fontFamily, node.content);
  }
  if (node.type === "frame" && node.clip_content && node.style.overflow === undefined) {
    css.overflow = "hidden";
  }
  if (node.type === "ellipse") css.borderRadius = "50%";
  if (node.type === "image") css.objectFit = node.object_fit;
  if (!node.visible) css.display = "none";
  return css;
}

export function tokensToCssVariables(document: DesignDocument, prefix = "designer"): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const token of Object.values(document.tokens)) {
    if (token.archived) continue;
    const name = token.path.replaceAll(".", "-").replace(/[^A-Za-z0-9_-]/g, "-");
    variables[`--${prefix}-${name}`] = String(token.value);
  }
  return variables;
}

export function tokenCssVariable(tokenId: TokenId, document: DesignDocument, prefix = "designer"): string | undefined {
  const token = document.tokens[tokenId];
  if (token === undefined || token.archived) return undefined;
  const name = token.path.replaceAll(".", "-").replace(/[^A-Za-z0-9_-]/g, "-");
  return `var(--${prefix}-${name})`;
}
