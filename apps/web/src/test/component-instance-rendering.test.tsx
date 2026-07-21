import {
  DesignDocumentSchema,
  createComponentNode,
  createInstanceNode,
  createSequentialIdFactory,
  createStarterDocument,
  createTextNode,
} from "@designer/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NodeView } from "../components/Canvas";

describe("component instance rendering", () => {
  it("renders an archived component master as non-interactive instance content", () => {
    const ids = createSequentialIdFactory("webcomponentsource");
    const document = createStarterDocument({
      now: "2026-07-21T00:00:00.000Z",
      idFactory: ids,
    });
    const frame = document.nodes[document.pages[0]!.children[0]!]!;
    if (frame.type !== "frame") throw new Error("starter frame missing");

    const label = createTextNode({
      name: "Component label",
      content: "Continue with source",
      archived: true,
      layout: { width: 180, height: 24 },
    }, ids);
    const master = createComponentNode({
      name: "Primary action master",
      component_key: "button.primary",
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
      name: "Primary action instance",
      component_id: master.id,
      layout: { x: 32, y: 40, width: 220, height: 48 },
    }, ids);
    document.nodes[label.id] = label;
    document.nodes[master.id] = master;
    document.nodes[instance.id] = instance;
    frame.children.push(instance.id);
    const strict = DesignDocumentSchema.parse(document);

    const html = renderToStaticMarkup(
      <NodeView document={strict} nodeId={instance.id} interactive={false} />,
    );
    expect(html).toContain("Continue with source");
    expect(html).toContain(`data-node-id="${instance.id}"`);
    expect(html).toContain(`data-component-source-node-id="${master.id}"`);
    expect(html).not.toContain(`data-node-id="${master.id}"`);
  });

  it("shows a bounded fallback when the immutable component source is unavailable", () => {
    const ids = createSequentialIdFactory("webcomponentmissing");
    const document = createStarterDocument({
      now: "2026-07-21T00:00:00.000Z",
      idFactory: ids,
    });
    const frame = document.nodes[document.pages[0]!.children[0]!]!;
    if (frame.type !== "frame") throw new Error("starter frame missing");
    const missingMasterId = ids("node");
    const instance = createInstanceNode({
      name: "Unavailable source",
      component_id: missingMasterId,
    }, ids);
    document.nodes[instance.id] = instance;
    frame.children.push(instance.id);
    const strict = DesignDocumentSchema.parse(document);

    const html = renderToStaticMarkup(
      <NodeView document={strict} nodeId={instance.id} interactive={false} />,
    );
    expect(html).toContain("Unavailable source");
  });
});
