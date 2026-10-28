/**
 * AIの発言・共有ノートの Markdown 表示(`shared/markdown-lite.ts` の解析結果を描く)。
 * 構想ノート画面(ConceptNoteView)と同じ見た目。`[[リンク]]` は文字として出し、`[文](URL)` は外部で開く。
 */
import { memo, useCallback, useMemo } from "react";
import { Linking, Text, View } from "react-native";
import { parseMarkdown } from "../../shared/markdown-lite.js";
import type { Block, Inline } from "../../shared/markdown-lite.js";
import type { Colors } from "./ui.js";

type MS = ReturnType<typeof mdStyles>;

function mdStyles(c: Colors) {
  const text = { color: c.foreground, fontSize: 14, lineHeight: 22 } as const;
  const tr = { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: c.border } as const;
  return {
    wrap: { gap: 8 },
    text,
    boldText: { ...text, fontWeight: "700" },
    bold: { fontWeight: "700" },
    italic: { fontStyle: "italic" },
    code: { fontFamily: "Menlo", backgroundColor: c.surface2, fontSize: 13 },
    link: { color: "#3b82f6", textDecorationLine: "underline" },
    heading: [
      { ...text, fontSize: 19, fontWeight: "700", marginTop: 6 },
      { ...text, fontSize: 16, fontWeight: "700", marginTop: 4 },
      { ...text, fontSize: 15, fontWeight: "700", marginTop: 2 },
    ],
    quote: { borderLeftWidth: 3, borderLeftColor: c.border, paddingLeft: 10 },
    codeBlock: { backgroundColor: c.surface2, borderRadius: 6, padding: 10 },
    codeText: { color: c.foreground, fontFamily: "Menlo", fontSize: 12 },
    hr: { height: 1, backgroundColor: c.border, marginVertical: 4 },
    list: { gap: 3 },
    li: [0, 1, 2, 3, 4].map((d) => ({
      flexDirection: "row" as const,
      gap: 6,
      paddingLeft: d * 16,
    })),
    liBody: { flex: 1 },
    marker: { ...text, width: 18 },
    table: { borderWidth: 1, borderColor: c.border, borderRadius: 6 },
    tr,
    trHead: { ...tr, backgroundColor: c.surface2 },
    td: { flex: 1, padding: 6 },
  } as const;
}

function LinkText({ label, href, style }: { label: string; href: string; style: object }) {
  const press = useCallback(() => void Linking.openURL(href), [href]);
  return (
    <Text style={style} onPress={press}>
      {label}
    </Text>
  );
}

function InlineItem({ p, s }: { p: Inline; s: MS }) {
  if (p.t === "bold") return <Text style={s.bold}>{p.v}</Text>;
  if (p.t === "italic") return <Text style={s.italic}>{p.v}</Text>;
  if (p.t === "code") return <Text style={s.code}>{p.v}</Text>;
  if (p.t === "wikilink") return <Text>{p.label}</Text>;
  if (p.t === "link") return <LinkText label={p.label} href={p.href} style={s.link} />;
  return <Text>{p.v}</Text>;
}

function InlineText({ parts, s, base }: { parts: Inline[]; s: MS; base?: object }) {
  return (
    <Text style={base ?? s.text} selectable>
      {parts.map((p) => (
        <InlineItem key={p.id} p={p} s={s} />
      ))}
    </Text>
  );
}

function ListView({ block, s }: { block: Extract<Block, { t: "list" }>; s: MS }) {
  return (
    <View style={s.list}>
      {block.items.map((it) => (
        <View key={it.id} style={s.li[it.depth]}>
          <Text style={s.marker}>{it.marker}</Text>
          <View style={s.liBody}>
            <InlineText parts={it.inl} s={s} />
          </View>
        </View>
      ))}
    </View>
  );
}

function TableView({ block, s }: { block: Extract<Block, { t: "table" }>; s: MS }) {
  return (
    <View style={s.table}>
      {block.rows.map((row) => (
        <View key={row.id} style={row.head ? s.trHead : s.tr}>
          {row.cells.map((cell) => (
            <View key={cell.id} style={s.td}>
              <InlineText parts={cell.inl} s={s} base={row.head ? s.boldText : undefined} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function BlockView({ block: b, s }: { block: Block; s: MS }) {
  if (b.t === "heading")
    return <InlineText parts={b.inl} s={s} base={s.heading[Math.min(b.level, 3) - 1]} />;
  if (b.t === "para") return <InlineText parts={b.inl} s={s} />;
  if (b.t === "quote")
    return (
      <View style={s.quote}>
        <InlineText parts={b.inl} s={s} />
      </View>
    );
  if (b.t === "code")
    return (
      <View style={s.codeBlock}>
        <Text style={s.codeText} selectable>
          {b.v}
        </Text>
      </View>
    );
  if (b.t === "hr") return <View style={s.hr} />;
  if (b.t === "list") return <ListView block={b} s={s} />;
  return <TableView block={b} s={s} />;
}

export const Markdown = memo(function Markdown({
  source,
  colors,
}: {
  source: string;
  colors: Colors;
}) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const s = useMemo(() => mdStyles(colors), [colors]);
  return (
    <View style={s.wrap}>
      {blocks.map((b) => (
        <BlockView key={b.id} block={b} s={s} />
      ))}
    </View>
  );
});
