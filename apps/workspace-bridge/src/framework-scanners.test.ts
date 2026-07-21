import { describe, expect, it } from "vitest";

import { scanFrameworkSource } from "./framework-scanners.js";

function scan(
  relativePath: string,
  contents: string,
  platforms: Parameters<typeof scanFrameworkSource>[0]["platforms"],
  maximumEntities = 100,
) {
  return scanFrameworkSource({ relativePath, contents, platforms, maximumEntities });
}

describe("framework-aware workspace scanners", () => {
  it("maps web components, file routes, router declarations, and design tokens", () => {
    const screen = scan("src/app/(shop)/products/[productId]/page.tsx", `
      const misleading = "export function StringOnly() { return null }";
      // export function CommentOnly() { return null }
      export function ProductPage() { return <main />; }
      const router = createBrowserRouter([
        { path: "/legacy-products", element: <ProductPage /> },
      ]);
    `, ["web"]);
    expect(screen.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "screen", name: "ProductPage", symbol: "ProductPage" }),
      expect.objectContaining({ kind: "route", name: "/products/:productId" }),
      expect.objectContaining({ kind: "route", name: "/legacy-products" }),
    ]));
    expect(screen.entities.map((entity) => entity.name)).not.toContain("StringOnly");
    expect(screen.entities.map((entity) => entity.name)).not.toContain("CommentOnly");

    const tokens = scan("src/theme/tokens.ts", `
      export const colors = {
        primary: "#2563eb",
        surface: "#ffffff",
      } as const;
    `, ["web"]);
    expect(tokens.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "token", name: "colors.primary", symbol: "colors.primary" }),
      expect.objectContaining({ kind: "token", name: "colors.surface", symbol: "colors.surface" }),
    ]));
  });

  it("maps Android Compose, activity, navigation, layout, and resource semantics", () => {
    const kotlin = scan("android/app/src/main/java/com/example/screens/Checkout.kt", `
      @Composable
      fun CheckoutScreen() = Unit
      fun FormattingHelper() = Unit
      class MainActivity : ComponentActivity()
      const val CheckoutRoute = "checkout"
      fun graph() { composable(route = "checkout/details/{id}") {} }
      // @Composable fun CommentScreen() = Unit
    `, ["android"]);
    expect(kotlin.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "screen", name: "CheckoutScreen" }),
      expect.objectContaining({ kind: "screen", name: "MainActivity" }),
      expect.objectContaining({ kind: "route", name: "checkout", symbol: "CheckoutRoute" }),
      expect.objectContaining({ kind: "route", name: "checkout/details/{id}" }),
    ]));
    expect(kotlin.entities.map((entity) => entity.name)).not.toContain("FormattingHelper");
    expect(kotlin.entities.map((entity) => entity.name)).not.toContain("CommentScreen");

    const navigation = scan("android/app/src/main/res/navigation/main.xml", `
      <navigation>
        <fragment android:id="@+id/checkoutFragment" android:name="com.example.CheckoutFragment" />
      </navigation>
    `, ["android"]);
    expect(navigation.entities).toContainEqual(expect.objectContaining({
      kind: "route",
      name: "checkoutFragment",
      symbol: "com.example.CheckoutFragment",
    }));

    const resources = scan("android/app/src/main/res/values/tokens.xml", `
      <resources>
        <color name="brand_primary">#123456</color>
        <dimen name="space_medium">16dp</dimen>
      </resources>
    `, ["android"]);
    expect(resources.entities.filter((entity) => entity.kind === "token").map((entity) => entity.name))
      .toEqual(["brand_primary", "space_medium"]);

    const drawable = scan("android/app/src/main/res/drawable/checkout_background.xml", "<shape />\n", ["android"]);
    expect(drawable.entities).toContainEqual(expect.objectContaining({ kind: "asset", name: "checkout_background" }));
  });

  it("maps SwiftUI/UIKit screens, typed routes, and scoped Apple tokens", () => {
    const swift = scan("ios/FormaSpec/Screens/HomeScreen.swift", `
      struct HomeScreen: View { var body: some View { Text("Home") } }
      final class CheckoutViewController: UIViewController {}
      struct ReceiptRecord: Codable {}
      enum AppRoute: Hashable {
        case home
        case detail(id: UUID), settings
      }
      // struct CommentView: View {}
    `, ["ios"]);
    expect(swift.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "screen", name: "HomeScreen" }),
      expect.objectContaining({ kind: "screen", name: "CheckoutViewController" }),
      expect.objectContaining({ kind: "route", name: "AppRoute.home", symbol: "AppRoute.home" }),
      expect.objectContaining({ kind: "route", name: "AppRoute.detail", symbol: "AppRoute.detail" }),
      expect.objectContaining({ kind: "route", name: "AppRoute.settings", symbol: "AppRoute.settings" }),
    ]));
    expect(swift.entities.map((entity) => entity.name)).not.toContain("ReceiptRecord");
    expect(swift.entities.map((entity) => entity.name)).not.toContain("CommentView");

    const tokens = scan("ios/FormaSpec/DesignSystem/ColorTokens.swift", `
      enum ColorTokens {
        static let brandPrimary = Color(red: 0.1, green: 0.2, blue: 0.3)
      }
    `, ["ios"]);
    expect(tokens.entities).toContainEqual(expect.objectContaining({
      kind: "token",
      name: "ColorTokens.brandPrimary",
      symbol: "ColorTokens.brandPrimary",
    }));
  });

  it("maps Flutter widgets, declared routes, GoRouter paths, and theme tokens", () => {
    const dart = scan("lib/screens/orders_screen.dart", `
      class OrdersScreen extends StatelessWidget {
        static const String routeName = "/orders";
      }
      class OrdersRepository {}
      final routes = <RouteBase>[
        GoRoute(path: "/orders/:id", builder: (context, state) => OrdersScreen()),
      ];
      // class CommentScreen extends StatelessWidget {}
    `, ["flutter"]);
    expect(dart.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "screen", name: "OrdersScreen" }),
      expect.objectContaining({ kind: "route", name: "/orders" }),
      expect.objectContaining({ kind: "route", name: "/orders/:id" }),
    ]));
    expect(dart.entities.map((entity) => entity.name)).not.toContain("OrdersRepository");
    expect(dart.entities.map((entity) => entity.name)).not.toContain("CommentScreen");

    const tokens = scan("lib/theme/spacing.dart", `
      abstract final class AppSpacing {
        static const double medium = 16.0;
      }
    `, ["flutter"]);
    expect(tokens.entities).toContainEqual(expect.objectContaining({
      kind: "token",
      name: "Spacing.medium",
      symbol: "Spacing.medium",
    }));
  });

  it("maps React Native screens, navigator declarations, ParamList routes, and token objects", () => {
    const native = scan("src/screens/HomeScreen.tsx", `
      export function HomeScreen() { return null; }
      export type RootStackParamList = {
        Home: undefined;
        Details: { id: string };
      };
      <Stack.Screen
        name="Home"
        component={HomeScreen}
      />
    `, ["react-native"]);
    expect(native.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "screen", name: "HomeScreen" }),
      expect.objectContaining({ kind: "route", name: "Home", symbol: "HomeScreen" }),
      expect.objectContaining({ kind: "route", name: "Details", symbol: "RootStackParamList.Details" }),
    ]));

    const tokens = scan("src/theme/colors.ts", `
      export const colors = {
        primary: "#0f172a",
      } as const;
    `, ["react-native"]);
    expect(tokens.entities).toContainEqual(expect.objectContaining({ kind: "token", name: "colors.primary" }));
  });

  it("rejects common semantic false positives and enforces the per-file entity bound", () => {
    const falsePositives = scan("src/lib/invoice.tsx", `
      export class InvoiceCalculator {}
      const path = "/private/tmp";
      const file = <File path="/private/tmp" />;
      const fixture = \`
        export function TemplateOnly() { return null; }
        path: "/template-route"
      \`;
      // const FakePolicy = 1;
    `, ["web"]);
    expect(falsePositives.entities).toEqual([]);

    const bounded = scan("src/theme/tokens.css", `
      :root {
        --one: 1px;
        --two: 2px;
      }
    `, ["web"], 1);
    expect(bounded.entities).toHaveLength(1);
    expect(bounded.truncated).toBe(true);
  });
});
