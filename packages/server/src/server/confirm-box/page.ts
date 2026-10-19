/**
 * 確認箱のモバイル向けHTMLページ(Safari→ホーム画面追加のPWAとして使う想定。iPhoneの公式Paseoアプリには
 * フォークのUIは届かないため、確認はこのページ+push通知で行う)。
 * 色: 緊急=オレンジ / 通常=緑(Toposのm.htmlの確認受信箱に合わせる)。DOMはtextContentで組み立て、
 * 件名・本文をHTMLとして解釈しない。
 */
export function renderConfirmBoxPage(): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="確認箱">
<title>確認箱</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 12px 12px 80px; max-width: 720px; margin-inline: auto; font-size: 17px; }
  header { display: flex; align-items: center; gap: 8px; position: sticky; top: 0; padding: 8px 0; background: Canvas; }
  h1 { font-size: 1.2em; margin: 0; flex: 1; }
  .badge { border-radius: 999px; padding: 2px 10px; font-weight: 700; color: #fff; }
  .badge.urgent { background: #e8710a; } .badge.normal { background: #2e9d4f; } .badge.zero { background: #888; }
  .item { border-left: 6px solid #2e9d4f; border-radius: 6px; padding: 10px 12px; margin: 10px 0; background: color-mix(in srgb, CanvasText 6%, Canvas); }
  .item.urgent { border-left-color: #e8710a; }
  .item.done { opacity: .55; }
  .meta { font-size: .8em; opacity: .7; }
  .subject { font-weight: 600; margin: 4px 0; word-break: break-word; }
  pre { white-space: pre-wrap; word-break: break-word; font: inherit; font-size: .9em; margin: 6px 0; max-height: 14em; overflow: auto; }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid #8884; background: Canvas; color: CanvasText; margin-right: 8px; }
  button.primary { background: #2e9d4f; color: #fff; border-color: #2e9d4f; }
  .bar { display: flex; gap: 8px; align-items: center; margin: 6px 0; }
  .empty { text-align: center; opacity: .6; margin: 40px 0; }
  .stale { color: #e8710a; }
</style>
</head>
<body>
<header>
  <h1>確認箱</h1>
  <span id="urgent" class="badge urgent" hidden></span>
  <span id="count" class="badge zero">0</span>
</header>
<div class="bar">
  <button id="ackall" class="primary">すべて既読</button>
  <label><input type="checkbox" id="showall"> 既読も表示</label>
</div>
<div id="status" class="meta"></div>
<div id="list"></div>
<script>
(function () {
  var BASE = "/api/confirm-box";
  var listEl = document.getElementById("list");
  var statusEl = document.getElementById("status");
  var showAll = document.getElementById("showall");

  function api(path, opts) {
    return fetch(BASE + path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts || {}))
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); });
  }
  function fmt(ts) {
    var d = new Date(ts);
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function ack(id, action) {
    return api("/items/" + encodeURIComponent(id) + "/ack", { method: "POST", body: JSON.stringify({ action: action }) }).then(load);
  }
  function render(data) {
    var s = data.summary;
    var count = document.getElementById("count");
    count.textContent = String(s.unread);
    count.className = "badge " + (s.unread === 0 ? "zero" : "normal");
    var urgent = document.getElementById("urgent");
    urgent.hidden = s.urgentUnread === 0;
    urgent.textContent = "緊急 " + s.urgentUnread;
    document.title = (s.unread > 0 ? "(" + s.unread + ") " : "") + "確認箱";
    listEl.textContent = "";
    if (data.items.length === 0) { listEl.appendChild(el("div", "empty", "確認事項はありません")); return; }
    data.items.forEach(function (it) {
      var card = el("div", "item " + it.urgency + (it.state === "new" ? "" : " done"));
      card.appendChild(el("div", "meta", fmt(it.ts) + " ・ " + it.source + (it.state === "new" ? "" : " ・ " + (it.state === "approved" ? "承認済み" : "既読"))));
      card.appendChild(el("div", "subject", it.subject));
      if (it.body) card.appendChild(el("pre", "", it.body));
      if (it.state === "new") {
        var read = el("button", "", "既読");
        read.onclick = function () { ack(it.id, "read"); };
        var ok = el("button", "primary", "承認");
        ok.onclick = function () { ack(it.id, "approve"); };
        card.appendChild(read); card.appendChild(ok);
      }
      listEl.appendChild(card);
    });
  }
  function load() {
    return api("/items?view=" + (showAll.checked ? "all" : "active") + "&limit=200")
      .then(function (d) { statusEl.textContent = "更新 " + fmt(Date.now()); statusEl.className = "meta"; render(d); })
      .catch(function (e) { statusEl.textContent = "読込失敗: " + e.message; statusEl.className = "meta stale"; });
  }
  document.getElementById("ackall").onclick = function () {
    if (confirm("未読をすべて既読にしますか?")) api("/ack-all", { method: "POST", body: "{}" }).then(load);
  };
  showAll.onchange = load;
  load();
  setInterval(load, 15000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
})();
</script>
</body>
</html>
`;
}
