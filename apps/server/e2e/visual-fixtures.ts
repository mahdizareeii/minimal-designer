import { deflateSync } from "node:zlib";

import {
  createEllipseNode,
  createFrameNode,
  createImageNode,
  createRectangleNode,
  createTextNode,
  type AssetId,
  type DesignDocument,
  type DesignNode,
  type DesignOperation,
  type NodeId,
  type NodeStyle,
  type PageId,
  type TextNode,
} from "@designer/core";
import { expect, type APIRequestContext } from "playwright/test";

export const visualFixtureKinds = [
  "desktop",
  "phone",
  "tablet",
  "persian-rtl",
  "typography",
  "clipping",
  "image",
] as const;

export type VisualFixtureKind = typeof visualFixtureKinds[number];

export interface VisualFixture {
  designId: string;
  pageId: PageId;
  rootId: NodeId;
  width: number;
  height: number;
}

interface RevisionEnvelope {
  version: number;
  document: DesignDocument;
}

interface UploadedAssetEnvelope {
  designAsset: { id: AssetId };
  operation: DesignOperation;
}

interface Scene {
  width: number;
  height: number;
  fill: string;
  nodes: DesignNode[];
  roots: NodeId[];
}

interface TextOptions {
  color: string;
  size: number;
  weight?: number;
  lineHeight?: number;
  family?: "Inter Variable" | "Vazirmatn Variable";
  align?: "left" | "center" | "right" | "start" | "end";
  direction?: TextNode["direction"];
  letterSpacing?: number;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function encodeRgbaPng(width: number, height: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const destination = row * (width * 4 + 1);
    scanlines[destination] = 0;
    rgba.copy(scanlines, destination + 1, row * width * 4, (row + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

class Builder {
  readonly nodes: DesignNode[] = [];

  text(
    name: string,
    content: string,
    x: number,
    y: number,
    width: number,
    height: number,
    options: TextOptions,
  ) {
    return this.add(createTextNode({
      name,
      content,
      direction: options.direction ?? "ltr",
      layout: { x, y, width, height },
      style: {
        color: options.color,
        typography: {
          font_family: options.family ?? "Inter Variable",
          font_size: options.size,
          font_weight: options.weight ?? 500,
          line_height: options.lineHeight ?? Math.round(options.size * 1.35),
          ...(options.align === undefined ? {} : { text_align: options.align }),
          ...(options.letterSpacing === undefined ? {} : { letter_spacing: options.letterSpacing }),
        },
      },
    }));
  }

  rect(
    name: string,
    x: number,
    y: number,
    width: number,
    height: number,
    fill: string,
    options: { radius?: number; rotation?: number; style?: NodeStyle } = {},
  ) {
    return this.add(createRectangleNode({
      name,
      layout: { x, y, width, height, ...(options.rotation === undefined ? {} : { rotation: options.rotation }) },
      style: { fill, ...(options.radius === undefined ? {} : { radius: options.radius }), ...options.style },
    }));
  }

  ellipse(name: string, x: number, y: number, width: number, height: number, fill: string) {
    return this.add(createEllipseNode({ name, layout: { x, y, width, height }, style: { fill } }));
  }

  frame(
    name: string,
    children: readonly DesignNode[],
    x: number,
    y: number,
    width: number,
    height: number,
    style: NodeStyle,
    clip = false,
  ) {
    return this.add(createFrameNode({
      name,
      children: children.map((child) => child.id),
      clip_content: clip,
      layout: { x, y, width, height },
      style,
    }));
  }

  image(name: string, assetId: AssetId, x: number, y: number, width: number, height: number) {
    return this.add(createImageNode({
      name,
      asset_id: assetId,
      alt: "Deterministic abstract editorial artwork",
      object_fit: "cover",
      layout: { x, y, width, height },
      style: { fill: "#18233e" },
    }));
  }

  private add<T extends DesignNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }
}

function cardStyle(): NodeStyle {
  return {
    fill: "#ffffff",
    radius: 20,
    border: { color: "#eaecf0", width: 1, style: "solid" },
    shadows: [{ x: 0, y: 10, blur: 28, spread: 0, color: "rgba(16,24,40,0.06)" }],
  };
}

function desktopScene(): Scene {
  const b = new Builder();
  const sidebar = b.rect("Navigation", 0, 0, 238, 900, "#101828");
  const logo = b.rect("Logo", 28, 28, 40, 40, "#7c6df2", { radius: 12 });
  const logoText = b.text("Logo text", "FS", 28, 37, 40, 22, { color: "#ffffff", size: 13, weight: 760, align: "center" });
  const product = b.text("Product", "NORTHSTAR", 82, 34, 126, 22, { color: "#ffffff", size: 15, weight: 720, letterSpacing: 1.2 });
  const activeNav = b.rect("Active nav", 20, 114, 198, 44, "#25334d", { radius: 12 });
  const nav = ["Overview", "Orders", "Fleet", "Customers", "Analytics", "Settings"].map((label, index) => b.text(
    `${label} nav`,
    label,
    42,
    126 + index * 49,
    150,
    22,
    { color: index === 0 ? "#ffffff" : "#98a2b3", size: 13, weight: index === 0 ? 670 : 530 },
  ));
  const userAvatar = b.ellipse("User avatar", 28, 808, 40, 40, "#d7d2ff");
  const userInitials = b.text("User initials", "MZ", 28, 819, 40, 18, { color: "#40378c", size: 11, weight: 760, align: "center" });
  const user = b.text("User", "Mehdi Zareei", 82, 808, 120, 22, { color: "#f2f4f7", size: 12, weight: 650 });
  const role = b.text("Role", "Workspace admin", 82, 832, 120, 18, { color: "#667085", size: 9 });

  const eyebrow = b.text("Date", "MONDAY · 19 JULY", 292, 44, 260, 20, { color: "#7f56d9", size: 10, weight: 720, letterSpacing: 1.4 });
  const title = b.text("Title", "Operations overview", 292, 76, 560, 52, { color: "#101828", size: 38, weight: 730, lineHeight: 48 });
  const subtitle = b.text("Subtitle", "Delivery quality, workload, and customer commitments in one place.", 292, 132, 690, 26, { color: "#667085", size: 14, weight: 470 });
  const search = b.rect("Search", 1110, 64, 278, 44, "#ffffff", { radius: 13, style: { border: { color: "#e4e7ec", width: 1, style: "solid" } } });
  const searchText = b.text("Search hint", "Search operations", 1132, 76, 220, 20, { color: "#98a2b3", size: 12 });

  const metricData = [
    ["On-time delivery", "96.8%", "+2.4%", "#039855"],
    ["Active routes", "184", "12 added", "#6941c6"],
    ["Exceptions", "07", "3 urgent", "#c4320a"],
  ] as const;
  const metrics = metricData.map(([label, value, trend, accent], index) => {
    const labelNode = b.text(`${label} label`, label, 24, 22, 210, 20, { color: "#667085", size: 12, weight: 560 });
    const valueNode = b.text(`${label} value`, value, 24, 56, 180, 40, { color: "#101828", size: 31, weight: 730, lineHeight: 37 });
    const trendNode = b.text(`${label} trend`, trend, 220, 28, 82, 18, { color: accent, size: 9, weight: 700, align: "right" });
    const bars = [34, 54, 42, 70, 58, 84].map((height, barIndex) => b.rect(
      `${label} bar ${barIndex}`,
      26 + barIndex * 42,
      142 - height / 2,
      26,
      height / 2,
      barIndex === 5 ? accent : `${accent}33`,
      { radius: 6 },
    ));
    return b.frame(`${label} card`, [labelNode, valueNode, trendNode, ...bars], 292 + index * 358, 184, 330, 164, cardStyle(), true);
  });

  const chartTitle = b.text("Chart title", "Delivery volume", 28, 24, 260, 26, { color: "#101828", size: 18, weight: 690 });
  const chartCaption = b.text("Chart caption", "Completed stops · last seven days", 28, 55, 300, 18, { color: "#98a2b3", size: 10 });
  const grid = [0, 1, 2, 3].map((index) => b.rect(`Grid ${index}`, 28, 116 + index * 72, 660, 1, "#eef2f6"));
  const chartBars = [150, 206, 176, 244, 216, 280, 258].flatMap((height, index) => {
    const x = 50 + index * 88;
    return [
      b.rect(`Chart bar ${index}`, x, 408 - height, 50, height, index === 6 ? "#7f6ff2" : "#d9d5ff", { radius: 11 }),
      b.text(`Chart day ${index}`, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][index]!, x, 424, 50, 18, { color: "#98a2b3", size: 9, weight: 600, align: "center" }),
    ];
  });
  const chart = b.frame("Delivery chart", [chartTitle, chartCaption, ...grid, ...chartBars], 292, 382, 748, 476, cardStyle(), true);

  const activityTitle = b.text("Activity title", "Priority activity", 24, 24, 240, 26, { color: "#101828", size: 18, weight: 690 });
  const activities = ([
    ["Route #1842 delayed", "Road closure reported", "#f04438"],
    ["Enterprise order ready", "24 parcels for dispatch", "#7f56d9"],
    ["SLA milestone reached", "West region above 98%", "#12b76a"],
    ["Capacity recommendation", "Add two evening routes", "#f79009"],
  ] as const).flatMap(([label, detail, color], index) => {
    const y = 82 + index * 90;
    return [
      b.ellipse(`${label} marker`, 26, y + 3, 12, 12, color),
      b.text(`${label} title`, label, 52, y, 228, 20, { color: "#344054", size: 11, weight: 650 }),
      b.text(`${label} detail`, detail, 52, y + 24, 228, 18, { color: "#98a2b3", size: 9 }),
      ...(index < 3 ? [b.rect(`${label} divider`, 52, y + 58, 238, 1, "#f2f4f7")] : []),
    ];
  });
  const activity = b.frame("Priority activity", [activityTitle, ...activities], 1064, 382, 324, 476, cardStyle(), true);

  return {
    width: 1440,
    height: 900,
    fill: "#f7f8fc",
    nodes: b.nodes,
    roots: [sidebar, logo, logoText, product, activeNav, ...nav, userAvatar, userInitials, user, role, eyebrow, title, subtitle, search, searchText, ...metrics, chart, activity].map((node) => node.id),
  };
}

function phoneScene(): Scene {
  const b = new Builder();
  const glowOne = b.ellipse("Glow one", -90, -100, 270, 270, "#4338ca");
  const glowTwo = b.ellipse("Glow two", 290, 140, 170, 170, "#7c3aed");
  const time = b.text("Time", "9:41", 24, 18, 60, 18, { color: "#e0e7ff", size: 11, weight: 650 });
  const greeting = b.text("Greeting", "Good morning,", 24, 72, 230, 22, { color: "#a5b4fc", size: 13, weight: 560 });
  const name = b.text("Name", "Mehdi", 24, 98, 230, 40, { color: "#ffffff", size: 30, weight: 730, lineHeight: 36 });
  const avatar = b.ellipse("Avatar", 320, 78, 44, 44, "#f5d0fe");
  const initials = b.text("Initials", "MZ", 320, 90, 44, 18, { color: "#701a75", size: 11, weight: 760, align: "center" });

  const balanceLabel = b.text("Balance label", "AVAILABLE BALANCE", 24, 24, 220, 18, { color: "#ddd6fe", size: 9, weight: 720, letterSpacing: 1.2 });
  const balance = b.text("Balance", "$24,680.00", 24, 56, 280, 44, { color: "#ffffff", size: 32, weight: 720, lineHeight: 40 });
  const change = b.text("Change", "+8.4% this month", 24, 112, 180, 20, { color: "#d1fae5", size: 10, weight: 650 });
  const digits = b.text("Digits", "••••  4821", 228, 158, 112, 18, { color: "#ede9fe", size: 10, weight: 650, align: "right", letterSpacing: 1.1 });
  const balanceCard = b.frame("Balance card", [balanceLabel, balance, change, digits], 24, 158, 342, 202, {
    fill: "#6d5ce7",
    radius: 26,
    shadows: [{ x: 0, y: 22, blur: 48, spread: 0, color: "rgba(38,26,120,0.42)" }],
  }, true);

  const quickTitle = b.text("Quick actions", "Quick actions", 24, 392, 220, 24, { color: "#f8fafc", size: 17, weight: 680 });
  const actions = ["Send", "Request", "Pay", "More"].flatMap((label, index) => {
    const x = 24 + index * 87;
    return [
      b.rect(`${label} tile`, x, 432, 72, 72, ["#312e81", "#3b2f73", "#243d57", "#34315a"][index]!, { radius: 20, style: { border: { color: "#ffffff18", width: 1, style: "solid" } } }),
      b.text(`${label} symbol`, ["↗", "↙", "✓", "•••"][index]!, x, 451, 72, 24, { color: "#ffffff", size: 17, weight: 720, align: "center" }),
      b.text(`${label} label`, label, x, 516, 72, 18, { color: "#cbd5e1", size: 9, weight: 580, align: "center" }),
    ];
  });

  const recentTitle = b.text("Recent activity", "Recent activity", 24, 568, 220, 24, { color: "#f8fafc", size: 17, weight: 680 });
  const rows = ([
    ["FormaSpec Cloud", "Workspace subscription", "−$48.00", "#c4b5fd"],
    ["Client transfer", "Today, 08:22", "+$2,400", "#86efac"],
    ["Travel card", "Yesterday", "−$186.40", "#fda4af"],
  ] as const).flatMap(([label, detail, amount, color], index) => {
    const y = 612 + index * 64;
    return [
      b.rect(`${label} icon`, 24, y, 44, 44, "#1e293b", { radius: 14, style: { border: { color: "#334155", width: 1, style: "solid" } } }),
      b.ellipse(`${label} dot`, 38, y + 14, 16, 16, color),
      b.text(`${label} title`, label, 82, y + 2, 168, 19, { color: "#e2e8f0", size: 11, weight: 640 }),
      b.text(`${label} detail`, detail, 82, y + 24, 168, 16, { color: "#64748b", size: 8 }),
      b.text(`${label} amount`, amount, 258, y + 12, 108, 19, { color: amount.startsWith("+") ? "#86efac" : "#f8fafc", size: 10, weight: 680, align: "right" }),
    ];
  });
  const home = b.rect("Home indicator", 132, 825, 126, 5, "#64748b", { radius: 3 });

  return {
    width: 390,
    height: 844,
    fill: "#0f172a",
    nodes: b.nodes,
    roots: [glowOne, glowTwo, time, greeting, name, avatar, initials, balanceCard, quickTitle, ...actions, recentTitle, ...rows, home].map((node) => node.id),
  };
}

function tabletScene(): Scene {
  const b = new Builder();
  const header = b.rect("Header", 0, 0, 834, 112, "#ffffff");
  const logo = b.rect("Logo", 34, 30, 46, 46, "#155eef", { radius: 14 });
  const logoText = b.text("Logo text", "C", 34, 40, 46, 24, { color: "#ffffff", size: 15, weight: 760, align: "center" });
  const brand = b.text("Brand", "CLARITY", 94, 36, 150, 22, { color: "#101828", size: 16, weight: 740, letterSpacing: 1.3 });
  const tabs = ["Overview", "Patients", "Schedule", "Insights"].map((label, index) => b.text(`${label} tab`, label, 330 + index * 105, 46, 90, 22, { color: index === 0 ? "#155eef" : "#667085", size: 11, weight: index === 0 ? 680 : 560, align: "center" }));
  const breadcrumb = b.text("Breadcrumb", "CARE WORKSPACE  /  CENTRAL CLINIC", 40, 150, 420, 18, { color: "#175cd3", size: 9, weight: 720, letterSpacing: 1.1 });
  const title = b.text("Title", "Good afternoon, Dr. Rahimi", 40, 182, 600, 44, { color: "#101828", size: 32, weight: 720, lineHeight: 40 });
  const caption = b.text("Caption", "Everything that needs attention across today’s care plan.", 40, 232, 620, 22, { color: "#667085", size: 13 });
  const action = b.rect("Action", 650, 185, 144, 46, "#155eef", { radius: 13 });
  const actionText = b.text("Action text", "+  Add appointment", 650, 198, 144, 20, { color: "#ffffff", size: 10, weight: 670, align: "center" });

  const stats = ([
    ["Appointments", "18", "3 waiting", "#175cd3"],
    ["Care plans", "42", "6 updates", "#027a48"],
    ["Messages", "09", "2 urgent", "#c4320a"],
  ] as const).map(([label, value, note, accent], index) => {
    const labelNode = b.text(`${label} label`, label, 22, 20, 170, 20, { color: "#667085", size: 10, weight: 580 });
    const valueNode = b.text(`${label} value`, value, 22, 52, 100, 38, { color: "#101828", size: 29, weight: 730, lineHeight: 34 });
    const noteNode = b.text(`${label} note`, note, 130, 62, 82, 18, { color: accent, size: 9, weight: 670, align: "right" });
    return b.frame(`${label} stat`, [labelNode, valueNode, noteNode], 40 + index * 258, 290, 238, 118, cardStyle(), true);
  });

  const agendaTitle = b.text("Agenda title", "Today’s schedule", 24, 22, 260, 24, { color: "#101828", size: 17, weight: 690 });
  const agendaMeta = b.text("Agenda meta", "Tuesday · 6 appointments", 24, 51, 260, 18, { color: "#98a2b3", size: 9 });
  const schedule = ([
    ["09:00", "Mina Karimi", "Follow-up consultation", "#175cd3"],
    ["10:30", "Saman Ahmadi", "Care plan review", "#6938ef"],
    ["12:15", "Niloofar Rezaei", "Initial assessment", "#027a48"],
    ["14:00", "Arash Mohammadi", "Remote consultation", "#c4320a"],
    ["15:30", "Sara Ebrahimi", "Lab result review", "#c11574"],
  ] as const).flatMap(([time, person, reason, accent], index) => {
    const y = 94 + index * 78;
    return [
      b.text(`${person} time`, time, 24, y + 5, 66, 18, { color: accent, size: 10, weight: 700, align: "center" }),
      b.ellipse(`${person} avatar`, 112, y - 2, 42, 42, `${accent}22`),
      b.text(`${person} initials`, person.split(" ").map((part) => part[0]).join(""), 112, y + 10, 42, 18, { color: accent, size: 10, weight: 740, align: "center" }),
      b.text(`${person} name`, person, 172, y - 2, 220, 20, { color: "#344054", size: 11, weight: 650 }),
      b.text(`${person} reason`, reason, 172, y + 23, 260, 18, { color: "#98a2b3", size: 9 }),
      ...(index < 4 ? [b.rect(`${person} divider`, 112, y + 57, 366, 1, "#f2f4f7")] : []),
    ];
  });
  const agenda = b.frame("Schedule", [agendaTitle, agendaMeta, ...schedule], 40, 444, 516, 500, cardStyle(), true);

  const qualityTitle = b.text("Quality title", "Care quality", 22, 22, 170, 24, { color: "#101828", size: 16, weight: 690 });
  const ring = b.ellipse("Quality ring", 34, 86, 146, 146, "#dbeafe");
  const ringCenter = b.ellipse("Quality center", 56, 108, 102, 102, "#ffffff");
  const score = b.text("Quality score", "94%", 56, 140, 102, 34, { color: "#155eef", size: 25, weight: 750, align: "center" });
  const qualityRows: DesignNode[] = ([
    ["Satisfaction", "4.8 / 5"],
    ["Adherence", "91%"],
    ["Response", "8 min"],
  ] as const).flatMap(([label, value], index) => {
    const y = 278 + index * 58;
    return [
      b.text(`${label} label`, label, 24, y, 110, 18, { color: "#667085", size: 9 }),
      b.text(`${label} value`, value, 132, y, 58, 18, { color: "#344054", size: 9, weight: 690, align: "right" }),
    ];
  });
  const quality = b.frame("Quality", [qualityTitle, ring, ringCenter, score, ...qualityRows], 580, 444, 214, 500, cardStyle(), true);
  const footer = b.text("Footer", "Next team review  ·  Wednesday 09:30  ·  Clinical quality room", 40, 1018, 754, 26, { color: "#667085", size: 12, weight: 580 });

  return {
    width: 834,
    height: 1194,
    fill: "#f8fafc",
    nodes: b.nodes,
    roots: [header, logo, logoText, brand, ...tabs, breadcrumb, title, caption, action, actionText, ...stats, agenda, quality, footer].map((node) => node.id),
  };
}

function persianRtlScene(): Scene {
  const b = new Builder();
  const rtl = { family: "Vazirmatn Variable" as const, align: "right" as const, direction: "rtl" as const };
  const sidebar = b.rect("ناوبری", 700, 0, 220, 720, "#172554");
  const mark = b.rect("نشان", 832, 28, 48, 48, "#818cf8", { radius: 14 });
  const markText = b.text("نشان متن", "هـ", 832, 39, 48, 24, { color: "#ffffff", size: 16, weight: 740, family: "Vazirmatn Variable", align: "center", direction: "rtl" });
  const brand = b.text("نام محصول", "همراه‌کار", 720, 34, 98, 28, { color: "#ffffff", size: 18, weight: 730, ...rtl });
  const active = b.rect("منوی فعال", 720, 118, 180, 44, "#312e81", { radius: 12 });
  const nav = ["نمای کلی", "سفارش‌ها", "مشتریان", "گزارش‌ها", "تنظیمات"].map((label, index) => b.text(`منوی ${label}`, label, 738, 129 + index * 52, 142, 24, { color: index === 0 ? "#ffffff" : "#c7d2fe", size: 13, weight: index === 0 ? 680 : 540, ...rtl }));
  const profile = b.text("کاربر", "مهدی زارعی\nمدیر سازمان", 734, 630, 146, 52, { color: "#ffffff", size: 11, weight: 620, lineHeight: 24, ...rtl });

  const date = b.text("تاریخ", "شنبه، ۲۸ تیر ۱۴۰۵", 360, 38, 300, 22, { color: "#4f46e5", size: 11, weight: 680, ...rtl });
  const title = b.text("عنوان", "داشبورد عملیات", 280, 74, 380, 48, { color: "#111827", size: 32, weight: 740, lineHeight: 44, ...rtl });
  const subtitle = b.text("زیرعنوان", "وضعیت سفارش‌ها و تعهدهای امروز را در یک نگاه بررسی کنید.", 130, 128, 530, 28, { color: "#6b7280", size: 14, ...rtl });
  const search = b.rect("جستجو", 34, 68, 220, 42, "#ffffff", { radius: 12, style: { border: { color: "#e5e7eb", width: 1, style: "solid" } } });
  const searchText = b.text("جستجو متن", "جستجو در سفارش‌ها", 56, 78, 178, 22, { color: "#9ca3af", size: 11, ...rtl });

  const cards: DesignNode[] = ([
    ["سفارش‌های فعال", "۱۸۴", "۱۲٪ رشد", "#4f46e5"],
    ["تحویل به‌موقع", "۹۶٪", "۲٪ بهتر", "#047857"],
    ["نیازمند بررسی", "۷", "۳ فوری", "#c2410c"],
  ] as const).map(([label, value, note, accent], index) => {
    const labelNode = b.text(`${label} برچسب`, label, 24, 20, 154, 22, { color: "#6b7280", size: 10, weight: 550, ...rtl });
    const valueNode = b.text(`${label} مقدار`, value, 24, 53, 154, 38, { color: "#111827", size: 28, weight: 740, ...rtl });
    const noteNode = b.text(`${label} روند`, note, 24, 104, 154, 20, { color: accent, size: 9, weight: 680, ...rtl });
    return b.frame(`${label} کارت`, [labelNode, valueNode, noteNode], 34 + index * 218, 190, 202, 148, cardStyle(), true);
  });

  const tableTitle = b.text("عنوان جدول", "آخرین سفارش‌ها", 420, 20, 206, 28, { color: "#111827", size: 17, weight: 700, ...rtl });
  const headers = ["وضعیت", "مبلغ", "مشتری", "شناسه"].map((label, index) => b.text(`ستون ${label}`, label, [28, 174, 326, 518][index]!, 82, [100, 108, 150, 106][index]!, 20, { color: "#9ca3af", size: 9, weight: 650, ...rtl }));
  const rows = ([
    ["ارسال شد", "۲٬۴۸۰٬۰۰۰", "سارا احمدی", "#FS-1842", "#047857"],
    ["آماده‌سازی", "۸۹۰٬۰۰۰", "علی رضایی", "#FS-1841", "#4f46e5"],
    ["نیازمند بررسی", "۳٬۱۲۰٬۰۰۰", "نیلوفر کریمی", "#FS-1840", "#c2410c"],
  ] as const).flatMap(([status, amount, customer, id, accent], index) => {
    const y = 122 + index * 62;
    return [
      b.text(`${id} وضعیت`, status, 28, y + 4, 100, 20, { color: accent, size: 9, weight: 650, ...rtl }),
      b.text(`${id} مبلغ`, amount, 150, y + 4, 132, 20, { color: "#374151", size: 10, weight: 620, ...rtl }),
      b.text(`${id} مشتری`, customer, 326, y + 4, 150, 20, { color: "#111827", size: 10, weight: 650, ...rtl }),
      b.text(`${id} شناسه`, id, 518, y + 4, 106, 20, { color: "#6b7280", size: 9, weight: 560, align: "right", direction: "ltr" }),
      ...(index < 2 ? [b.rect(`${id} divider`, 28, y + 44, 596, 1, "#f3f4f6")] : []),
    ];
  });
  const table = b.frame("جدول", [tableTitle, ...headers, ...rows], 34, 370, 626, 316, cardStyle(), true);

  return {
    width: 920,
    height: 720,
    fill: "#f8fafc",
    nodes: b.nodes,
    roots: [sidebar, mark, markText, brand, active, ...nav, profile, date, title, subtitle, search, searchText, ...cards, table].map((node) => node.id),
  };
}

function typographyScene(): Scene {
  const b = new Builder();
  const rail = b.rect("Rail", 0, 0, 18, 720, "#6d5ce7");
  const kicker = b.text("Kicker", "FORMASPEC FOUNDATION / TYPE", 62, 46, 500, 22, { color: "#6d5ce7", size: 10, weight: 720, letterSpacing: 1.7 });
  const title = b.text("Title", "Words are interface.", 62, 86, 820, 72, { color: "#111827", size: 54, weight: 730, lineHeight: 66, letterSpacing: -1.5 });
  const intro = b.text("Intro", "A deterministic specimen for hierarchy, rhythm, multilingual content, and variable font weight.", 62, 170, 760, 54, { color: "#667085", size: 18, weight: 460, lineHeight: 27 });
  const rule = b.rect("Rule", 62, 252, 976, 1, "#e4e7ec");
  const samples = [
    ["DISPLAY / 46", "Design decisions, made visible.", 46, 720, 58],
    ["HEADING / 30", "A shared language for product teams", 30, 680, 40],
    ["TITLE / 21", "Structured canvas and exact handoff", 21, 650, 30],
    ["BODY / 16", "Every element keeps stable identity, typed properties, and revision history.", 16, 480, 24],
    ["CAPTION / 12", "INTER VARIABLE · LATIN · TABULAR 0123456789", 12, 620, 18],
  ] as const;
  const rows = samples.flatMap(([label, content, size, weight, lineHeight], index) => {
    const y = 286 + index * 66;
    return [
      b.text(`${label} label`, label, 62, y + 5, 150, 18, { color: "#98a2b3", size: 9, weight: 680, letterSpacing: 1.1 }),
      b.text(`${label} sample`, content, 236, y, 800, lineHeight + 8, { color: "#101828", size, weight, lineHeight, letterSpacing: size >= 30 ? -0.7 : 0 }),
    ];
  });
  const rtlPanel = b.rect("RTL panel", 62, 620, 976, 64, "#f4f3ff", { radius: 16 });
  const mixed = b.text("Mixed type", "FormaSpec — طراحی دقیق، handoff روشن", 88, 636, 924, 32, { color: "#42307d", size: 20, weight: 620, lineHeight: 30, family: "Vazirmatn Variable", align: "center", direction: "auto" });
  return { width: 1100, height: 720, fill: "#fffdf8", nodes: b.nodes, roots: [rail, kicker, title, intro, rule, ...rows, rtlPanel, mixed].map((node) => node.id) };
}

function clippingScene(): Scene {
  const b = new Builder();
  const title = b.text("Title", "Clipping & containment", 64, 48, 520, 46, { color: "#ffffff", size: 34, weight: 720, lineHeight: 42 });
  const caption = b.text("Caption", "Rounded frames preserve rotated overflow geometry.", 64, 98, 680, 26, { color: "#94a3b8", size: 14 });
  const purple = b.rect("Purple slab", -110, -90, 420, 320, "#7c3aed", { radius: 72, rotation: -16 });
  const coral = b.rect("Coral slab", 486, 174, 330, 300, "#fb7185", { radius: 84, rotation: 18 });
  const blue = b.ellipse("Blue orb", 430, -110, 330, 330, "#38bdf8");
  const lines = Array.from({ length: 9 }, (_, index) => b.rect(`Grid ${index}`, 34 + index * 78, -20, 1, 480, "rgba(255,255,255,0.12)", { rotation: index % 2 ? 8 : -4 }));
  const badge = b.rect("Badge", 44, 44, 156, 34, "rgba(15,23,42,0.72)", { radius: 17 });
  const badgeText = b.text("Badge text", "CLIP CONTENT · ON", 44, 53, 156, 18, { color: "#e0e7ff", size: 9, weight: 720, align: "center", letterSpacing: 1.1 });
  const innerTitle = b.text("Inner title", "Geometry stays inside the contract.", 44, 252, 520, 44, { color: "#ffffff", size: 28, weight: 710, lineHeight: 36 });
  const innerCaption = b.text("Inner caption", "Canvas, prototype, and PNG output resolve the same structured tree.", 44, 310, 520, 50, { color: "#dbeafe", size: 14, lineHeight: 22 });
  const clipped = b.frame("Clipped composition", [purple, coral, blue, ...lines, badge, badgeText, innerTitle, innerCaption], 64, 158, 772, 420, { fill: "#1e3a8a", radius: 34, border: { color: "rgba(255,255,255,0.18)", width: 1, style: "solid" }, shadows: [{ x: 0, y: 30, blur: 70, spread: 0, color: "rgba(2,6,23,0.55)" }] }, true);
  const footer = b.text("Footer", "FRAME 772 × 420   ·   RADIUS 34   ·   ROTATION PRESERVED", 64, 622, 772, 20, { color: "#64748b", size: 9, weight: 650, letterSpacing: 1.2 });
  return { width: 900, height: 650, fill: "#0f172a", nodes: b.nodes, roots: [title, caption, clipped, footer].map((node) => node.id) };
}

function imageScene(assetId: AssetId): Scene {
  const b = new Builder();
  const image = b.image("Editorial image", assetId, 0, 0, 988, 410);
  const tint = b.rect("Image tint", 0, 0, 988, 410, "rgba(15,23,42,0.18)");
  const pill = b.rect("Category pill", 32, 30, 104, 30, "rgba(255,255,255,0.90)", { radius: 15 });
  const category = b.text("Category", "FIELD NOTES", 32, 37, 104, 17, { color: "#344054", size: 9, weight: 720, align: "center", letterSpacing: 1 });
  const imageCard = b.frame("Image card", [image, tint, pill, category], 56, 52, 988, 410, { fill: "#18233e", radius: 28, shadows: [{ x: 0, y: 26, blur: 60, spread: 0, color: "rgba(16,24,40,0.20)" }] }, true);
  const eyebrow = b.text("Eyebrow", "DESIGN OPERATIONS · 8 MIN READ", 56, 500, 420, 20, { color: "#6941c6", size: 10, weight: 720, letterSpacing: 1.2 });
  const title = b.text("Title", "A calmer way to turn product intent into implementation.", 56, 532, 720, 82, { color: "#101828", size: 32, weight: 720, lineHeight: 40, letterSpacing: -0.5 });
  const body = b.text("Body", "Structured visuals, exact revision context, and a reviewable handoff keep teams aligned without hiding decisions in screenshots.", 56, 626, 760, 50, { color: "#667085", size: 14, lineHeight: 22 });
  const avatar = b.ellipse("Author avatar", 900, 534, 48, 48, "#d1fadf");
  const initials = b.text("Author initials", "FS", 900, 548, 48, 20, { color: "#05603a", size: 11, weight: 750, align: "center" });
  const author = b.text("Author", "FormaSpec Studio\n19 July 2026", 832, 594, 162, 46, { color: "#344054", size: 10, weight: 620, lineHeight: 22, align: "center" });
  return { width: 1100, height: 720, fill: "#ffffff", nodes: b.nodes, roots: [imageCard, eyebrow, title, body, avatar, initials, author].map((node) => node.id) };
}

function sceneFor(kind: VisualFixtureKind, assetId?: AssetId): Scene {
  if (kind === "desktop") return desktopScene();
  if (kind === "phone") return phoneScene();
  if (kind === "tablet") return tabletScene();
  if (kind === "persian-rtl") return persianRtlScene();
  if (kind === "typography") return typographyScene();
  if (kind === "clipping") return clippingScene();
  if (!assetId) throw new Error("The image fixture requires an uploaded asset.");
  return imageScene(assetId);
}

async function deterministicArtwork(): Promise<Buffer> {
  const width = 988;
  const height = 410;
  const pixels = Buffer.alloc(width * height * 4);
  const fill = (
    left: number,
    top: number,
    fillWidth: number,
    fillHeight: number,
    source: readonly [number, number, number, number],
  ) => {
    const sourceAlpha = source[3] / 255;
    for (let y = top; y < top + fillHeight; y += 1) {
      for (let x = left; x < left + fillWidth; x += 1) {
        const offset = (y * width + x) * 4;
        const destinationAlpha = pixels[offset + 3]! / 255;
        const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
        for (let channel = 0; channel < 3; channel += 1) {
          const destination = pixels[offset + channel]!;
          pixels[offset + channel] = Math.round(
            (source[channel]! * sourceAlpha + destination * destinationAlpha * (1 - sourceAlpha))
              / Math.max(outputAlpha, Number.EPSILON),
          );
        }
        pixels[offset + 3] = Math.round(outputAlpha * 255);
      }
    }
  };
  fill(0, 0, width, height, [30, 42, 82, 255]);
  fill(558, 0, 430, 410, [232, 106, 146, 255]);
  fill(70, 70, 280, 270, [246, 196, 83, 255]);
  fill(390, 205, 220, 160, [95, 209, 200, 255]);
  fill(770, 54, 140, 290, [118, 105, 232, 255]);
  fill(500, 0, 72, 410, [255, 255, 255, 31]);
  return encodeRgbaPng(width, height, pixels);
}

async function uploadArtwork(request: APIRequestContext, designId: string): Promise<UploadedAssetEnvelope> {
  const response = await request.post(`/api/assets?designId=${encodeURIComponent(designId)}`, {
    multipart: {
      file: {
        name: "formaspec-visual-fixture.png",
        mimeType: "image/png",
        buffer: await deterministicArtwork(),
      },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<UploadedAssetEnvelope>;
}

export async function createVisualFixture(request: APIRequestContext, kind: VisualFixtureKind): Promise<VisualFixture> {
  const preset = kind === "phone" ? "phone" : kind === "tablet" ? "tablet" : "web";
  const createResponse = await request.post("/api/designs", {
    data: {
      name: `Visual regression · ${kind}`,
      preset,
      idempotencyKey: `visual-create-${kind}-${crypto.randomUUID()}`,
    },
  });
  expect(createResponse.ok(), await createResponse.text()).toBe(true);
  const created = await createResponse.json() as RevisionEnvelope;
  const page = created.document.pages[0];
  const rootId = page?.children[0];
  expect(page).toBeTruthy();
  expect(rootId).toBeTruthy();

  const uploaded = kind === "image" ? await uploadArtwork(request, created.document.id) : undefined;
  const scene = sceneFor(kind, uploaded?.designAsset.id);
  const operations: DesignOperation[] = [
    {
      type: "update_node",
      node_id: rootId!,
      patch: {
        name: `Visual fixture · ${kind}`,
        layout: { width: scene.width, height: scene.height },
        style: { fill: scene.fill },
        clip_content: true,
        metadata: { visual_fixture: kind },
      },
    },
    ...(uploaded ? [uploaded.operation] : []),
    {
      type: "create_tree",
      parent: { node_id: rootId! },
      root_ids: scene.roots,
      nodes: scene.nodes,
    },
  ];
  const commitResponse = await request.post(`/api/designs/${encodeURIComponent(created.document.id)}/revisions`, {
    data: {
      baseVersion: created.version,
      operations,
      idempotencyKey: `visual-commit-${kind}-${crypto.randomUUID()}`,
      message: `Add deterministic ${kind} visual fixture`,
    },
  });
  expect(commitResponse.ok(), await commitResponse.text()).toBe(true);

  return {
    designId: created.document.id,
    pageId: page!.id,
    rootId: rootId!,
    width: scene.width,
    height: scene.height,
  };
}
