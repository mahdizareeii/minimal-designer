export type FrameworkScannerPlatform = "web" | "android" | "ios" | "flutter" | "react-native" | "generic-git";
export type FrameworkScannerEntityKind = "component" | "screen" | "route" | "token" | "asset" | "flow" | "business-rule";

export interface FrameworkScannerEntity {
  kind: FrameworkScannerEntityKind;
  name: string;
  symbol: string | null;
  line: number;
}

export interface FrameworkScanResult {
  entities: FrameworkScannerEntity[];
  truncated: boolean;
}

interface SourceViews {
  commentless: string;
  code: string;
  commentlessLines: string[];
  codeLines: string[];
}

const SAFE_SYMBOL = /^[A-Za-z_][A-Za-z0-9_.:#<>,?()[\]-]{0,239}$/;
const SOURCE_SCREEN_PATH = /(?:^|\/)(?:pages?|screens?|views?)(?:\/|$)/i;
const THEME_PATH = /(?:^|\/)(?:theme|themes|tokens?|design[-_]?system|styles?)(?:\/|\.|$)/i;

function maskSource(source: string, maskStrings: boolean): string {
  let output = "";
  let quote: "\"" | "'" | "`" | null = null;
  let lineComment = false;
  let blockTerminator: "*/" | "-->" | null = null;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const pair = source.slice(index, index + 2);
    const quadruple = source.slice(index, index + 4);
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += character;
      } else {
        output += " ";
      }
      continue;
    }
    if (blockTerminator !== null) {
      if (source.startsWith(blockTerminator, index)) {
        output += " ".repeat(blockTerminator.length);
        index += blockTerminator.length - 1;
        blockTerminator = null;
      } else {
        output += character === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (quote !== null) {
      if (character === "\\") {
        output += maskStrings ? " " : character;
        if (index + 1 < source.length) {
          const escaped = source[index + 1]!;
          output += escaped === "\n" ? "\n" : (maskStrings ? " " : escaped);
          index += 1;
        }
        continue;
      }
      if (character === quote) quote = null;
      output += character === "\n" ? "\n" : (maskStrings ? " " : character);
      continue;
    }
    if (quadruple === "<!--") {
      output += "    ";
      index += 3;
      blockTerminator = "-->";
      continue;
    }
    if (pair === "//") {
      output += "  ";
      index += 1;
      lineComment = true;
      continue;
    }
    if (pair === "/*") {
      output += "  ";
      index += 1;
      blockTerminator = "*/";
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      output += maskStrings ? " " : character;
      continue;
    }
    output += character;
  }
  return output;
}

function sourceViews(contents: string): SourceViews {
  const commentless = maskSource(contents, false);
  const code = maskSource(contents, true);
  return {
    commentless,
    code,
    commentlessLines: commentless.split("\n"),
    codeLines: code.split("\n"),
  };
}

function lineStarts(value: string): number[] {
  const starts = [0];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineAtOffset(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle]! <= offset) low = middle + 1;
    else high = middle - 1;
  }
  return high + 1;
}

function portableExtension(relativePath: string): string {
  const basename = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  return dot < 0 ? "" : basename.slice(dot).toLowerCase();
}

function portableBasename(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf("/") + 1);
}

function basenameWithoutExtension(relativePath: string): string {
  const basename = portableBasename(relativePath);
  const dot = basename.lastIndexOf(".");
  return dot < 0 ? basename : basename.slice(0, dot);
}

function pascalCase(value: string): string | null {
  const parts = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const result = parts.map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`).join("");
  return /^[A-Z][A-Za-z0-9_]*$/.test(result) ? result : null;
}

function braceDelta(value: string): number {
  let delta = 0;
  for (const character of value) {
    if (character === "{") delta += 1;
    else if (character === "}") delta -= 1;
  }
  return delta;
}

function screenKind(relativePath: string, name: string): "component" | "screen" {
  return SOURCE_SCREEN_PATH.test(relativePath)
    || /(?:Screen|Page|ViewController|Activity|Fragment)$/.test(name)
    ? "screen"
    : "component";
}

function localRoute(value: string): string | null {
  const route = value.trim();
  if (route.length === 0 || route.length > 200 || /[\0\r\n]/.test(route) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(route)) return null;
  return route;
}

class CandidateCollector {
  readonly entities: FrameworkScannerEntity[] = [];
  truncated = false;
  readonly #keys = new Set<string>();

  constructor(private readonly maximumEntities: number) {}

  add(kind: FrameworkScannerEntityKind, nameValue: string, symbolValue: string | null, lineValue: number): void {
    const name = nameValue.trim().slice(0, 240);
    if (name.length === 0 || /[\0\r\n]/.test(name)) return;
    const symbol = symbolValue !== null && SAFE_SYMBOL.test(symbolValue) ? symbolValue : null;
    const line = Math.max(1, Math.floor(lineValue));
    const key = `${kind}\0${name}\0${symbol ?? ""}`;
    if (this.#keys.has(key)) return;
    if (this.entities.length >= this.maximumEntities) {
      this.truncated = true;
      return;
    }
    this.#keys.add(key);
    this.entities.push({ kind, name, symbol, line });
  }

  finish(): FrameworkScanResult {
    this.entities.sort((left, right) => (
      left.line - right.line
      || left.kind.localeCompare(right.kind)
      || left.name.localeCompare(right.name)
      || (left.symbol ?? "").localeCompare(right.symbol ?? "")
    ));
    return { entities: this.entities, truncated: this.truncated };
  }
}

function scanNamedFlowsAndRules(views: SourceViews, collector: CandidateCollector): void {
  for (let index = 0; index < views.codeLines.length; index += 1) {
    const line = views.codeLines[index]!;
    const declaration = /\b(?:class|struct|function|func|fun|const|let|val)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line)?.[1];
    if (!declaration) continue;
    if (/(?:Flow|Journey|Workflow)$/.test(declaration)) collector.add("flow", declaration, declaration, index + 1);
    if (/(?:Policy|Rule|Validator|Constraint)$/.test(declaration)) collector.add("business-rule", declaration, declaration, index + 1);
  }
}

function scanCssTokens(views: SourceViews, collector: CandidateCollector): void {
  for (let index = 0; index < views.commentlessLines.length; index += 1) {
    const expression = /(--[A-Za-z0-9_-]+)\s*:/g;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(views.commentlessLines[index]!)) !== null) {
      collector.add("token", match[1]!, null, index + 1);
    }
  }
}

function scanJavaScriptTokenObjects(relativePath: string, views: SourceViews, collector: CandidateCollector): void {
  if (!THEME_PATH.test(relativePath)) return;
  let objectName: string | null = null;
  let depth = 0;
  for (let index = 0; index < views.codeLines.length; index += 1) {
    const line = views.codeLines[index]!;
    if (objectName === null) {
      const match = /\b(?:export\s+)?const\s+(colors?|spacing|typography|radii|radius|shadows?|breakpoints?|tokens?|theme)\s*(?::[^=]{0,200})?=\s*\{/.exec(line);
      if (!match) continue;
      objectName = match[1]!;
      depth = braceDelta(line.slice(match.index));
      const remainder = line.slice(line.indexOf("{", match.index) + 1);
      const sameLineKey = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(remainder)?.[1];
      if (sameLineKey) collector.add("token", `${objectName}.${sameLineKey}`, `${objectName}.${sameLineKey}`, index + 1);
      if (depth <= 0) objectName = null;
      continue;
    }
    if (depth === 1) {
      const key = /^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line)?.[1];
      if (key) collector.add("token", `${objectName}.${key}`, `${objectName}.${key}`, index + 1);
    }
    depth += braceDelta(line);
    if (depth <= 0) objectName = null;
  }
}

function scanReactComponents(relativePath: string, views: SourceViews, collector: CandidateCollector): void {
  const extension = portableExtension(relativePath);
  const jsxSyntax = extension === ".tsx" || extension === ".jsx";
  for (let index = 0; index < views.codeLines.length; index += 1) {
    const line = views.codeLines[index]!;
    const className = /\bclass\s+([A-Z][A-Za-z0-9_]*)\s+extends\s+(?:(?:React\.)?(?:Pure)?Component)\b/.exec(line)?.[1];
    if (className) collector.add(screenKind(relativePath, className), className, className, index + 1);
    const typedConstant = /\b(?:export\s+)?const\s+([A-Z][A-Za-z0-9_]*)\s*:\s*(?:React\.)?(?:FC|FunctionComponent|ComponentType)\b/.exec(line)?.[1];
    if (typedConstant) collector.add(screenKind(relativePath, typedConstant), typedConstant, typedConstant, index + 1);
    if (!jsxSyntax) continue;
    const functionName = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Z][A-Za-z0-9_]*)\s*[<(]/.exec(line)?.[1];
    if (functionName) collector.add(screenKind(relativePath, functionName), functionName, functionName, index + 1);
    const constantName = /\b(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)\b[^=]{0,300}=\s*(?:(?:React\.)?(?:memo|forwardRef)\s*\(|(?:async\s*)?(?:\([^)]*\)|[A-Za-z_][A-Za-z0-9_]*)\s*=>)/.exec(line)?.[1];
    if (constantName) collector.add(screenKind(relativePath, constantName), constantName, constantName, index + 1);
  }
  if (extension === ".vue" && /<template\b/.test(views.commentless)) {
    const componentName = pascalCase(basenameWithoutExtension(relativePath));
    if (componentName) {
      const line = views.commentlessLines.findIndex((candidate) => /<template\b/.test(candidate)) + 1;
      collector.add(screenKind(relativePath, componentName), componentName, componentName, Math.max(1, line));
    }
  }
}

function nextRoute(relativePath: string): string | null {
  const segments = relativePath.split("/");
  const basename = portableBasename(relativePath);
  if (/^page\.(?:[cm]?[jt]sx?)$/i.test(basename)) {
    const appIndex = segments.lastIndexOf("app");
    if (appIndex < 0) return null;
    const routeSegments = segments.slice(appIndex + 1, -1)
      .filter((segment) => !/^\(.+\)$/.test(segment) && !segment.startsWith("@"))
      .map((segment) => segment
        .replace(/^\[\.\.\.([^\]]+)\]$/, "*$1")
        .replace(/^\[\[\.\.\.([^\]]+)\]\]$/, "*$1?")
        .replace(/^\[([^\]]+)\]$/, ":$1"));
    return `/${routeSegments.join("/")}`.replace(/\/$/, "") || "/";
  }
  const pagesIndex = segments.lastIndexOf("pages");
  if (pagesIndex < 0 || !/\.(?:[cm]?[jt]sx?)$/i.test(basename)) return null;
  const routeSegments = [...segments.slice(pagesIndex + 1)];
  routeSegments[routeSegments.length - 1] = basename.replace(/\.(?:[cm]?[jt]sx?)$/i, "");
  if (routeSegments[0] === "api" || routeSegments[0]?.startsWith("_")) return null;
  if (routeSegments.at(-1) === "index") routeSegments.pop();
  return (`/${routeSegments.map((segment) => segment
    .replace(/^\[\.\.\.([^\]]+)\]$/, "*$1")
    .replace(/^\[\[\.\.\.([^\]]+)\]\]$/, "*$1?")
    .replace(/^\[([^\]]+)\]$/, ":$1")).join("/")}`).replace(/\/$/, "") || "/";
}

function scanWebRoutes(relativePath: string, views: SourceViews, collector: CandidateCollector): void {
  const fileRoute = nextRoute(relativePath);
  if (fileRoute) collector.add("route", fileRoute, null, 1);
  const starts = lineStarts(views.commentless);
  const jsxRoute = /<(?:Route|[A-Za-z_][A-Za-z0-9_]*\.Route)\b[^>\n]{0,2000}\bpath\s*=\s*(?:\{\s*)?["'`]([^"'`]{1,200})/g;
  let match: RegExpExecArray | null;
  while ((match = jsxRoute.exec(views.commentless)) !== null) {
    const route = localRoute(match[1]!);
    if (route) collector.add("route", route, null, lineAtOffset(starts, match.index));
  }
  if (!/(?:^|\/)(?:routes?|router|routing)(?:\/|\.|$)/i.test(relativePath)
    && !/\b(?:createBrowserRouter|createHashRouter|createRoutesFromElements|useRoutes)\b/.test(views.code)) return;
  for (let index = 0; index < views.commentlessLines.length; index += 1) {
    const route = localRoute(/\bpath\s*:\s*["'`]([^"'`]{1,200})["'`]/.exec(views.commentlessLines[index]!)?.[1] ?? "");
    if (route) collector.add("route", route, null, index + 1);
  }
}

function scanReactNativeNavigation(views: SourceViews, collector: CandidateCollector): void {
  const starts = lineStarts(views.commentless);
  const screenTag = /<[A-Za-z_][A-Za-z0-9_]*\.Screen\b([^>]{0,3000})>/g;
  let match: RegExpExecArray | null;
  while ((match = screenTag.exec(views.commentless)) !== null) {
    const attributes = match[1]!;
    const route = localRoute(/\bname\s*=\s*["']([^"']{1,200})["']/.exec(attributes)?.[1] ?? "");
    if (!route) continue;
    const component = /\bcomponent\s*=\s*\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/.exec(attributes)?.[1] ?? null;
    collector.add("route", route, component, lineAtOffset(starts, match.index));
  }

  for (let index = 0; index < views.commentlessLines.length; index += 1) {
    const declaredRoute = /\b(?:export\s+)?(?:const|let|var)\s+(?:routeName|route)\s*=\s*["'`]([^"'`]{1,200})["'`]/.exec(views.commentlessLines[index]!)?.[1];
    const route = localRoute(declaredRoute ?? "");
    if (route) collector.add("route", route, null, index + 1);
  }

  let paramList: { name: string; depth: number } | null = null;
  for (let index = 0; index < views.codeLines.length; index += 1) {
    const codeLine = views.codeLines[index]!;
    const textLine = views.commentlessLines[index]!;
    if (paramList === null) {
      const declaration = /\b(?:export\s+)?(?:type|interface)\s+([A-Za-z_][A-Za-z0-9_]*(?:ParamList|Routes))\b[^\{]*\{/.exec(codeLine)?.[1];
      if (!declaration) continue;
      paramList = { name: declaration, depth: braceDelta(codeLine.slice(codeLine.indexOf("{"))) };
      if (paramList.depth <= 0) paramList = null;
      continue;
    }
    if (paramList.depth === 1) {
      const routeName = /^\s*(?:readonly\s+)?(?:["']([^"']+)["']|([A-Za-z_][A-Za-z0-9_]*))\??\s*:/.exec(textLine);
      const route = localRoute(routeName?.[1] ?? routeName?.[2] ?? "");
      if (route) collector.add("route", route, `${paramList.name}.${route}`, index + 1);
    }
    paramList.depth += braceDelta(codeLine);
    if (paramList.depth <= 0) paramList = null;
  }
}

function scanAndroid(relativePath: string, views: SourceViews, collector: CandidateCollector): void {
  const extension = portableExtension(relativePath);
  if (extension === ".kt" || extension === ".kts") {
    let composablePending = 0;
    for (let index = 0; index < views.codeLines.length; index += 1) {
      const line = views.codeLines[index]!;
      if (/\@Composable\b/.test(line)) composablePending = 5;
      const composable = /\bfun\s+([A-Z][A-Za-z0-9_]*)\s*\(/.exec(line)?.[1];
      if (composable && (composablePending > 0 || /\@Composable\b/.test(line))) {
        collector.add(screenKind(relativePath, composable), composable, composable, index + 1);
        composablePending = 0;
      } else if (line.trim().length > 0 && !line.trim().startsWith("@")) {
        composablePending = Math.max(0, composablePending - 1);
      }
      const classMatch = /\bclass\s+([A-Z][A-Za-z0-9_]*)\b[^:{]{0,300}:\s*([^\{]{1,300})/.exec(line);
      if (classMatch) {
        const [, name, bases] = classMatch;
        if (/\b(?:ComponentActivity|AppCompatActivity|Activity|Fragment)\b/.test(bases!)) collector.add("screen", name!, name!, index + 1);
        else if (/\b(?:View|ViewGroup|RecyclerView)\b/.test(bases!)) collector.add("component", name!, name!, index + 1);
      }
      const routeConstant = /\bconst\s+val\s+([A-Za-z_][A-Za-z0-9_]*(?:Route|Destination)[A-Za-z0-9_]*)\s*=\s*["']([^"']{1,200})["']/.exec(views.commentlessLines[index]!);
      const route = localRoute(routeConstant?.[2] ?? "");
      if (route) collector.add("route", route, routeConstant![1]!, index + 1);
      if (THEME_PATH.test(relativePath)) {
        const token = /\b(?:const\s+)?val\s+([A-Za-z_][A-Za-z0-9_]*)\b[^=]{0,160}=\s*(?:Color\s*\(|(?:[-+]?\d+(?:\.\d+)?)\.(?:dp|sp)\b|Typography\s*\(|Shapes\s*\(|FontFamily\s*\()/.exec(views.commentlessLines[index]!)?.[1];
        if (token) collector.add("token", token, token, index + 1);
      }
    }
    const starts = lineStarts(views.commentless);
    const composeRoute = /\b(?:composable|navigation)\s*\(\s*(?:route\s*=\s*)?["']([^"']{1,200})["']/g;
    let match: RegExpExecArray | null;
    while ((match = composeRoute.exec(views.commentless)) !== null) {
      const route = localRoute(match[1]!);
      if (route) collector.add("route", route, null, lineAtOffset(starts, match.index));
    }
  }
  if (extension === ".java") {
    for (let index = 0; index < views.codeLines.length; index += 1) {
      const declaration = /\bclass\s+([A-Z][A-Za-z0-9_]*)\s+extends\s+([A-Za-z_][A-Za-z0-9_.]*)/.exec(views.codeLines[index]!);
      if (!declaration) continue;
      if (/(?:Activity|Fragment)$/.test(declaration[2]!)) collector.add("screen", declaration[1]!, declaration[1]!, index + 1);
      else if (/(?:View|ViewGroup|RecyclerView)$/.test(declaration[2]!)) collector.add("component", declaration[1]!, declaration[1]!, index + 1);
    }
  }
  if (extension !== ".xml") return;
  const layout = /(?:^|\/)res\/layout(?:-[^/]+)?\/([A-Za-z0-9_]+)\.xml$/i.exec(relativePath)?.[1];
  if (layout) collector.add(/^(?:activity|fragment|screen)_/.test(layout) ? "screen" : "component", layout, null, 1);
  const drawable = /(?:^|\/)res\/drawable(?:-[^/]+)?\/([A-Za-z0-9_]+)\.xml$/i.exec(relativePath)?.[1];
  if (drawable) collector.add("asset", drawable, null, 1);
  for (let index = 0; index < views.commentlessLines.length; index += 1) {
    const token = /<(?:color|dimen|string|style)\s+name=["']([^"']+)["']/.exec(views.commentlessLines[index]!)?.[1];
    if (token) collector.add("token", token, null, index + 1);
  }
  const starts = lineStarts(views.commentless);
  const destination = /<(?:fragment|activity|dialog)\b([^>]{0,4000})>/g;
  let destinationMatch: RegExpExecArray | null;
  while ((destinationMatch = destination.exec(views.commentless)) !== null) {
    const attributes = destinationMatch[1]!;
    const identifier = /\bandroid:id=["']@\+?id\/([A-Za-z_][A-Za-z0-9_]*)["']/.exec(attributes)?.[1];
    if (!identifier) continue;
    const className = /\bandroid:name=["']([A-Za-z_][A-Za-z0-9_.]*)["']/.exec(attributes)?.[1] ?? null;
    collector.add("route", identifier, className, lineAtOffset(starts, destinationMatch.index));
  }
}

function splitTopLevelComma(value: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      result.push(value.slice(start, index));
      start = index + 1;
    }
  }
  result.push(value.slice(start));
  return result;
}

function scanIos(relativePath: string, views: SourceViews, collector: CandidateCollector): void {
  const extension = portableExtension(relativePath);
  if (extension === ".swift") {
    let routeEnum: { name: string; depth: number } | null = null;
    for (let index = 0; index < views.codeLines.length; index += 1) {
      const codeLine = views.codeLines[index]!;
      const swiftUi = /\bstruct\s+([A-Z][A-Za-z0-9_]*)\s*:\s*[^\{\n]*\bView\b/.exec(codeLine)?.[1];
      if (swiftUi) collector.add(screenKind(relativePath, swiftUi), swiftUi, swiftUi, index + 1);
      const uiKit = /\bclass\s+([A-Z][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_.]*)/.exec(codeLine);
      if (uiKit) {
        if (/(?:UI|NS)?ViewController$/.test(uiKit[2]!)) collector.add("screen", uiKit[1]!, uiKit[1]!, index + 1);
        else if (/(?:UI|NS)(?:View|Control)$/.test(uiKit[2]!)) collector.add("component", uiKit[1]!, uiKit[1]!, index + 1);
      }
      if (routeEnum === null) {
        const declaration = /\benum\s+([A-Z][A-Za-z0-9_]*(?:Route|Routes|Destination|Destinations|Screen|Screens))\b[^\{]*\{/.exec(codeLine)?.[1];
        if (declaration) routeEnum = { name: declaration, depth: braceDelta(codeLine.slice(codeLine.indexOf("{"))) };
      } else {
        if (routeEnum.depth === 1) {
          const cases = /^\s*case\s+(.+)$/.exec(codeLine)?.[1];
          if (cases) {
            for (const candidate of splitTopLevelComma(cases)) {
              const caseName = /^\s*([a-z][A-Za-z0-9_]*)\b/.exec(candidate)?.[1];
              if (caseName) collector.add("route", `${routeEnum.name}.${caseName}`, `${routeEnum.name}.${caseName}`, index + 1);
            }
          }
        }
        routeEnum.depth += braceDelta(codeLine);
        if (routeEnum.depth <= 0) routeEnum = null;
      }
      if (THEME_PATH.test(relativePath)) {
        const token = /\bstatic\s+(?:let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\b[^=]{0,160}=\s*(?:Color\s*\(|UIColor\s*\(|Font\.|UIFont\.|CGFloat\s*\(|[-+]?\d+(?:\.\d+)?\b)/.exec(views.commentlessLines[index]!)?.[1];
        if (token) {
          const container = pascalCase(basenameWithoutExtension(relativePath));
          const symbol = container ? `${container}.${token}` : token;
          collector.add("token", symbol, symbol, index + 1);
        }
      }
    }
  }
  if (extension === ".m" || extension === ".mm" || extension === ".h") {
    for (let index = 0; index < views.codeLines.length; index += 1) {
      const declaration = /@interface\s+([A-Z][A-Za-z0-9_]*)\s*:\s*([A-Z][A-Za-z0-9_]*)/.exec(views.codeLines[index]!);
      if (!declaration) continue;
      if (/(?:ViewController|Controller)$/.test(declaration[2]!)) collector.add("screen", declaration[1]!, declaration[1]!, index + 1);
      else if (/(?:View|Control)$/.test(declaration[2]!)) collector.add("component", declaration[1]!, declaration[1]!, index + 1);
    }
  }
  if (extension !== ".storyboard" && extension !== ".xib") return;
  const starts = lineStarts(views.commentless);
  const controller = /<viewController\b([^>]{0,4000})>/g;
  let match: RegExpExecArray | null;
  while ((match = controller.exec(views.commentless)) !== null) {
    const attributes = match[1]!;
    const identifier = /\bstoryboardIdentifier=["']([^"']{1,200})["']/.exec(attributes)?.[1];
    const className = /\bcustomClass=["']([A-Za-z_][A-Za-z0-9_.]*)["']/.exec(attributes)?.[1] ?? null;
    if (identifier) collector.add("route", identifier, className, lineAtOffset(starts, match.index));
    if (className) collector.add("screen", className, className, lineAtOffset(starts, match.index));
  }
}

function scanFlutter(relativePath: string, views: SourceViews, collector: CandidateCollector): void {
  if (portableExtension(relativePath) !== ".dart") return;
  for (let index = 0; index < views.codeLines.length; index += 1) {
    const widget = /\bclass\s+([A-Z][A-Za-z0-9_]*)\s+extends\s+(?:StatelessWidget|StatefulWidget|ConsumerWidget|HookWidget)\b/.exec(views.codeLines[index]!)?.[1];
    if (widget) collector.add(screenKind(relativePath, widget), widget, widget, index + 1);
    const namedRoute = /\bstatic\s+const(?:\s+String)?\s+(?:routeName|route)\s*=\s*["']([^"']{1,200})["']/.exec(views.commentlessLines[index]!)?.[1];
    const route = localRoute(namedRoute ?? "");
    if (route) collector.add("route", route, "routeName", index + 1);
    if (THEME_PATH.test(relativePath)) {
      const token = /\b(?:static\s+)?(?:const|final)\s+(?:[A-Za-z_][A-Za-z0-9_<>?]*\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:Color\s*\(|TextStyle\s*\(|EdgeInsets\.|BorderRadius\.|[-+]?\d+(?:\.\d+)?\b)/.exec(views.commentlessLines[index]!)?.[1];
      if (token) {
        const container = pascalCase(basenameWithoutExtension(relativePath));
        const symbol = container ? `${container}.${token}` : token;
        collector.add("token", symbol, symbol, index + 1);
      }
    }
  }
  const starts = lineStarts(views.commentless);
  const goRoute = /\b(?:GoRoute|AutoRoute)\s*\(([\s\S]{0,3000}?)\)/g;
  let match: RegExpExecArray | null;
  while ((match = goRoute.exec(views.commentless)) !== null) {
    const route = localRoute(/\bpath\s*:\s*["']([^"']{1,200})["']/.exec(match[1]!)?.[1] ?? "");
    if (route) collector.add("route", route, null, lineAtOffset(starts, match.index));
  }
  if (/\broutes\s*:/.test(views.code)) {
    for (let index = 0; index < views.commentlessLines.length; index += 1) {
      const route = localRoute(/^\s*["']([^"']{1,200})["']\s*:/.exec(views.commentlessLines[index]!)?.[1] ?? "");
      if (route) collector.add("route", route, null, index + 1);
    }
  }
}

export function scanFrameworkSource(input: {
  relativePath: string;
  contents: string;
  platforms: readonly FrameworkScannerPlatform[];
  maximumEntities: number;
}): FrameworkScanResult {
  const collector = new CandidateCollector(input.maximumEntities);
  const views = sourceViews(input.contents);
  const extension = portableExtension(input.relativePath);
  const platforms = new Set(input.platforms);

  scanNamedFlowsAndRules(views, collector);
  if ((platforms.has("web") || platforms.has("react-native"))
    && [".css", ".scss", ".html", ".vue"].includes(extension)) scanCssTokens(views, collector);
  if (platforms.has("web") || platforms.has("react-native")) {
    scanReactComponents(input.relativePath, views, collector);
    if ([".js", ".jsx", ".ts", ".tsx", ".vue"].includes(extension)) {
      scanJavaScriptTokenObjects(input.relativePath, views, collector);
    }
  }
  if (platforms.has("web") && [".js", ".jsx", ".ts", ".tsx"].includes(extension)) {
    scanWebRoutes(input.relativePath, views, collector);
  }
  if (platforms.has("react-native") && [".js", ".jsx", ".ts", ".tsx"].includes(extension)) {
    scanReactNativeNavigation(views, collector);
  }
  if (platforms.has("android")) scanAndroid(input.relativePath, views, collector);
  if (platforms.has("ios")) scanIos(input.relativePath, views, collector);
  if (platforms.has("flutter")) scanFlutter(input.relativePath, views, collector);
  return collector.finish();
}
