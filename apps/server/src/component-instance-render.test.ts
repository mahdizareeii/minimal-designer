import {
  DesignDocumentSchema,
  createComponentNode,
  createInstanceNode,
  createSequentialIdFactory,
  createStarterDocument,
  createTextNode,
} from "@designer/core";
import { describe, expect, it } from "vitest";

import { renderHtmlDocument } from "./render.js";

describe("component instance HTML rendering", () => {
  it("renders the immutable archived component source instead of a name placeholder", () => {
    const ids = createSequentialIdFactory("servercomponentsource");
    const document = createStarterDocument({
      preset: "phone",
      now: "2026-07-21T00:00:00.000Z",
      idFactory: ids,
    });
    const frame = document.nodes[document.pages[0]!.children[0]!]!;
    if (frame.type !== "frame") throw new Error("starter frame missing");

    const label = createTextNode({
      content: "Rendered component state",
      archived: true,
      layout: { width: 180, height: 24 },
    }, ids);
    const master = createComponentNode({
      name: "Button master",
      component_key: "button.rendered",
      children: [label.id],
      archived: true,
      layout: {
        width: 220,
        height: 48,
        mode: "horizontal",
        align_items: "center",
        justify_content: "center",
      },
      style: { fill: "#2457ff", color: "#ffffff", radius: 12 },
    }, ids);
    const instance = createInstanceNode({
      name: "Placeholder name must not be rendered",
      component_id: master.id,
      layout: { x: 24, y: 32, width: 220, height: 48 },
    }, ids);
    document.nodes[label.id] = label;
    document.nodes[master.id] = master;
    document.nodes[instance.id] = instance;
    frame.children.push(instance.id);

    const rendered = renderHtmlDocument(
      DesignDocumentSchema.parse(document),
      { nodeId: frame.id, maxSize: 512 },
      () => null,
    );
    expect(rendered.html).toContain("Rendered component state");
    expect(rendered.html).toContain(`data-component-source-node-id="${master.id}"`);
    expect(rendered.html).not.toContain("Placeholder name must not be rendered");
  });

  it("fails visibly and finitely for a cyclic component source", () => {
    const ids = createSequentialIdFactory("servercomponentcycle");
    const document = createStarterDocument({
      now: "2026-07-21T00:00:00.000Z",
      idFactory: ids,
    });
    const frame = document.nodes[document.pages[0]!.children[0]!]!;
    if (frame.type !== "frame") throw new Error("starter frame missing");
    const firstId = ids("node");
    const secondId = ids("node");
    const first = createInstanceNode({ id: firstId, component_id: secondId, archived: true }, ids);
    const second = createInstanceNode({ id: secondId, component_id: firstId, archived: true }, ids);
    const visible = createInstanceNode({ component_id: firstId }, ids);
    document.nodes[first.id] = first;
    document.nodes[second.id] = second;
    document.nodes[visible.id] = visible;
    frame.children.push(visible.id);

    const rendered = renderHtmlDocument(DesignDocumentSchema.parse(document), { nodeId: frame.id }, () => null);
    expect(rendered.html).toContain("Component cycle");
    expect(rendered.html.match(/Component cycle/g)).toHaveLength(1);
  });
});
