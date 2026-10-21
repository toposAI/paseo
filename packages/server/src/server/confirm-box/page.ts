/**
 * 確認箱のHTMLページ(スマホでもPCでも開ける。Safari→ホーム画面追加のPWAとしても使う)。
 *
 * **このページは「スマホ用の代替経路」ではない**(2026-10-21 訂正)。iPhone も PC も Paseo の
 * **Web版**を使っているので、**フォークのUI改造はどちらにも届く**。確認箱のPWAとサイドバーは
 * **どちらも本命**で、片方が他方の代役ではない。
 *
 * 色: 緊急=オレンジ / 通常=緑。DOMはtextContentで組み立て、件名・本文をHTMLとして解釈しない。
 *
 * ## 段階的开示(4段。2026-10-21)
 * ① 一覧 = **題名だけ**(+「止まっている本数」バッジ)。推奨や本数を題名に詰め込まない。
 * ② 展開 = **選択肢(タップで決定)** + `summary`(数行)。**ここで大半が決まる。**
 * ③ 「背景を開く」= `background`(整形済みの詳細)。
 * ④ チャット欄 = 背景を開いても分からないときだけ。
 *
 * 決めたときに「どこまで開いていたか」(`depth`)と「どの選択肢をタップしたか」(`chosen`)を
 * ack に載せる。健全性指標は **チャット欄への到達率** で、背景を開いて決まるのは正常
 * (背景を読む時間ではなく、AIに聞きに行く往復を消すのが狙い)。
 *
 * 同じ `group` の項目は背景を共有する: 1回開けば同じ束の他の項目でも開いたままにし、
 * 選択肢だけ切り替えて連続で決められるようにする(**束ねるのは背景だけで、判断は1件ずつ**)。
 *
 * ## チャット欄(A案・2026-10-21 ユーザー決定)
 * ④ で質問を打つと **`thread_ref` の元スレへ送られ、返答がこの箱に戻ってくる**(箱を閉じずに
 * 聞ける)。「箱の中にQ&A欄は作らない」という以前の設計は、**聞かれた内容がそのまま学習ログに
 * 残らない**ことを理由に破棄した(元スレを開くだけだと、質問文を feedback スレが手作業で拾う
 * ことになる)。長い相談は「元スレを開く」でスレ本文を読む。
 *
 * 送信はデーモン側(`POST /items/:id/chat`)が担う。フォークに**エージェント宛メッセージの
 * HTTPルートは無い**ため、`sendPromptToAgent()` を通す経路を `bootstrap.ts` が gateway として
 * 配線する(`chat.ts`)。返答は元スレのタイムラインを `clientMessageId` で切り出して取り込む。
 * **gateway が未配線のときは送れない**(質問文の記録だけ行い、その旨を出す)。
 *
 * 入力中は15秒ポーリングの再描画を止める(打ちかけの文字とフォーカスが飛ぶため)。返答の
 * 取り込みだけは進める。
 */
export function renderConfirmBoxPage(options: { serverId?: string } = {}): string {
  // 元スレを開くリンクは /h/<serverId>/agent/<id>。serverId はデーモン自身のIDで、
  // 未配線ならリンクを出さない(IDのコピーに落ちる)。JSへは文字列リテラルとして埋めるので、
  // 想定外の文字は落としてから入れる。
  const serverId = (options.serverId ?? "").replace(/[^A-Za-z0-9_-]/g, "");
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
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 6px 0; }
  pre { white-space: pre-wrap; word-break: break-word; font: inherit; font-size: .9em; margin: 6px 0; max-height: 14em; overflow: auto; }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid #8884; background: Canvas; color: CanvasText; margin-right: 8px; }
  button.primary { background: #2e9d4f; color: #fff; border-color: #2e9d4f; }
  button:disabled { opacity: .5; }
  a { color: #2e9d4f; }
  .bar { display: flex; gap: 8px; align-items: center; margin: 6px 0; }
  .empty { text-align: center; opacity: .6; margin: 40px 0; }
  .stale { color: #e8710a; }
  .stop { background: #e8710a; color: #fff; border-radius: 999px; padding: 1px 8px; font-size: .75em; font-weight: 700; }
  .detail { margin-top: 8px; border-top: 1px solid #8883; padding-top: 8px; }
  .summary { font-size: .95em; }
  .options { display: flex; flex-direction: column; gap: 8px; margin: 10px 0; }
  .options button { margin: 0; text-align: left; }
  .options button.rec { border-color: #2e9d4f; border-width: 2px; }
  .chip { font-size: .7em; font-weight: 700; color: #fff; background: #2e9d4f; border-radius: 999px; padding: 1px 6px; margin-right: 6px; vertical-align: middle; }
  details.bg { margin: 8px 0; }
  details.bg > summary { cursor: pointer; font-size: .9em; opacity: .8; }
  .chat textarea { width: 100%; box-sizing: border-box; font: inherit; font-size: .95em; padding: 8px; border-radius: 8px; border: 1px solid #8884; background: Canvas; color: CanvasText; margin-bottom: 8px; }
  .chatlog { margin: 8px 0; }
  .turn { border-left: 3px solid #8884; padding: 2px 0 2px 8px; margin: 8px 0; }
  .turn.user { border-left-color: #2e9d4f; }
  .turn.ack { border-left-color: #8884; opacity: .8; }
  .turn .who { font-size: .72em; opacity: .7; }
  .turn pre { max-height: 20em; margin: 2px 0; }
  .hint { font-size: .78em; opacity: .7; margin: 4px 0; }
  .decided { font-size: .9em; margin: 6px 0; }
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
  var SERVER_ID = ${JSON.stringify(serverId)};
  var listEl = document.getElementById("list");
  var statusEl = document.getElementById("status");
  var showAll = document.getElementById("showall");

  // 15秒ごとの再描画で開いていた状態が畳まれないよう、開閉はDOMではなくここで持つ。
  // depth もここから計算する(ackのたびにDOMを読み直すより、状態が1箇所にまとまる)。
  var expanded = {};   // id → 展開した
  var bgOpen = {};     // id → 背景を開いた
  var chatOpen = {};   // id → チャット欄を開いた
  var groupBg = {};    // group → その束の背景を開いた(1回読めば以降は選択肢だけ)
  var drafts = {};     // id → チャット欄の下書き(送っていない質問文)
  var chatData = {};   // id → {questions, turns, canSend, transcriptError}
  var chatBusy = {};   // id → 送信中
  var lastData = null; // 直近の応答(開閉のたびに取り直さず、手元で描き直すため)

  function draftKey(id) { return "cbq:" + id; }
  function loadDraft(id) {
    if (drafts[id] === undefined) {
      try { drafts[id] = localStorage.getItem(draftKey(id)) || ""; } catch (e) { drafts[id] = ""; }
    }
    return drafts[id];
  }
  function saveDraft(id, text) {
    drafts[id] = text;
    try {
      if (text) localStorage.setItem(draftKey(id), text);
      else localStorage.removeItem(draftKey(id));
    } catch (e) { /* プライベートモード等では諦める(下書きは揮発するだけ) */ }
  }

  function depthOf(it) {
    if (chatOpen[it.id]) return "chat";
    if (bgOpen[it.id] || (it.group && groupBg[it.group])) return "background";
    if (expanded[it.id]) return "expanded";
    return "list";
  }

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

  /** 決定を記録する。action="approve" は「選択肢をタップして決めた」も含む
   * (どれを選んだかは chosen が持つ。集計は feedback スレの担当)。 */
  function decide(it, action, chosen) {
    var body = { action: action, depth: depthOf(it) };
    if (chosen) body.chosen = chosen;
    // 送らずに残っている下書きだけを chat_question に載せる。送った質問は chat イベントとして
    // 既に残っているので、ここで二重に数えない(送信成功時に下書きを消している)。
    var q = loadDraft(it.id).trim();
    if (q) body.chat_question = q;
    return api("/items/" + encodeURIComponent(it.id) + "/ack", {
      method: "POST", body: JSON.stringify(body),
    }).then(function () { saveDraft(it.id, ""); load(); });
  }

  /** 元スレへの導線。**長い相談はスレ本文で読みたい**ので、チャット欄を開かなくても出す。 */
  function threadRow(it) {
    var row = el("div", "hint");
    if (!it.threadRef) {
      row.textContent = "元スレの参照がありません";
      return row;
    }
    if (SERVER_ID && it.threadRef.kind === "paseo_agent") {
      var open = el("a", "", "元スレを開く");
      open.href = "/h/" + SERVER_ID + "/agent/" + encodeURIComponent(it.threadRef.id);
      open.target = "_blank";
      open.rel = "noopener";
      row.appendChild(open);
      row.appendChild(el("span", "", " "));
    } else {
      row.appendChild(el("span", "", "元スレ: " + it.threadRef.kind + " "));
    }
    row.appendChild(el("code", "", it.threadRef.id));
    var copy = el("button", "", "コピー");
    copy.onclick = function () {
      var text = it.threadRef.id;
      if (navigator.clipboard) navigator.clipboard.writeText(text);
      else {
        var t = el("textarea"); t.value = text; document.body.appendChild(t);
        t.select(); document.execCommand("copy"); document.body.removeChild(t);
      }
      copy.textContent = "コピーした";
      setTimeout(function () { copy.textContent = "コピー"; }, 1500);
    };
    row.appendChild(copy);
    return row;
  }

  // --- チャット欄(A案): 質問は元スレへ送られ、返答がここに戻ってくる ---

  function setChatStatus(it, text) {
    var s = document.getElementById("chatstatus-" + it.id);
    if (s) s.textContent = text;
  }

  function loadChat(it) {
    return api("/items/" + encodeURIComponent(it.id) + "/chat")
      .then(function (d) { chatData[it.id] = d; renderChat(it); })
      .catch(function (e) {
        chatData[it.id] = { questions: [], turns: [], canSend: false, transcriptError: e.message };
        renderChat(it);
      });
  }

  function renderChat(it) {
    var log = document.getElementById("chatlog-" + it.id);
    if (!log) return;  // チャット欄を閉じている
    var d = chatData[it.id];
    log.textContent = "";
    if (!d) { log.appendChild(el("div", "hint", "読み込み中…")); return; }
    var turns = d.turns || [];
    var questions = d.questions || [];
    var replies = d.replies || [];
    var answered = false;
    if (turns.length) {
      // 元スレのタイムラインが読めたときは、それが会話の正本(質問も含めて並ぶ)。
      turns.forEach(function (t) {
        var row = el("div", "turn " + t.role);
        row.appendChild(el("div", "who", t.role === "user" ? "あなた" : "元スレ"));
        row.appendChild(el("pre", "", t.text));
        log.appendChild(row);
        if (t.role !== "user") answered = true;
      });
    } else if (questions.length) {
      // 元スレが読めない/無い項目でも、聞いたことは必ず見せる(記録は残っている)。
      questions.forEach(function (q) {
        var row = el("div", "turn user");
        row.appendChild(el("div", "who", "あなた"));
        row.appendChild(el("pre", "", q.question));
        log.appendChild(row);
      });
    }
    // 箱へ直接書かれた返事(受領・応答ワーカー・元スレ)。元スレが既に答えているなら、
    // ワーカーの重複回答は出さない(転送した質問は元スレの返答とワーカーのLLM回答の
    // 両方が残るため。2026-10-22)。受領だけは常に出す(無反応に見せない)。
    replies.forEach(function (r) {
      var text = String(r.text || "").trim();
      if (!text) return;
      if (r.by !== "ack" && answered) return;
      if (r.by !== "ack") answered = true;
      var row = el("div", "turn " + (r.by === "ack" ? "ack" : "assistant"));
      row.appendChild(el("div", "who",
        r.by === "ack" ? "受領" : (r.by === "origin_thread" ? "元スレ" : "返事")));
      row.appendChild(el("pre", "", text));
      log.appendChild(row);
    });
    if ((questions.length || turns.length) && !answered) {
      log.appendChild(el("div", "hint", d.transcriptError
        ? "返答を読めませんでした(" + d.transcriptError + ")。「元スレを開く」で確認してください。"
        : "返事を作っています。出たらここに出ます。"));
    }
    var send = document.getElementById("chatsend-" + it.id);
    // 送り先(元スレ)が無い項目でも質問は記録され、応答ワーカーが返す。
    // よって**送信可否でボタンを殺さない**(2026-10-22。殺すと73%の項目で無反応に見える)。
    if (send) send.disabled = Boolean(chatBusy[it.id]);
  }

  function sendChat(it) {
    var ta = document.getElementById("chatin-" + it.id);
    var text = (ta ? ta.value : "").trim();
    if (!text || chatBusy[it.id]) return;
    chatBusy[it.id] = true;
    setChatStatus(it, "送信中…");
    api("/items/" + encodeURIComponent(it.id) + "/chat", {
      method: "POST", body: JSON.stringify({ question: text }),
    }).then(function (r) {
      // 送れたら下書きを消す(決定時に chat_question として二重に載せないため)。
      saveDraft(it.id, "");
      if (ta) ta.value = "";
      chatBusy[it.id] = false;
      setChatStatus(it, r.sent
        ? "送りました。返答はここに出ます。"
        : "送りました。返事はここに出ます(元スレへの転送はしていません)。");
      return loadChat(it);
    }).catch(function (e) {
      chatBusy[it.id] = false;
      // 記録は送信より先。HTTPエラー(3桁)なら質問は残っていて、応答ワーカーが返す。
      // 通信断(数字でない)では記録できたか分からないので、そう書かない。
      var recorded = /^[0-9]{3}$/.test(String(e.message));
      setChatStatus(it, recorded
        ? "元スレへは送れませんでした(質問は記録済み。返事はここに出ます): " + e.message
        : "送れませんでした: " + e.message);
      if (recorded) return loadChat(it);
      renderChat(it);
    });
  }

  function chatBlock(it) {
    var box = el("div", "chat");
    box.hidden = !chatOpen[it.id];
    // 送り先はPaseoのスレッドだけ。Topos側のスレッドID等は送れないので記録だけになる。
    var canSendThread = Boolean(it.threadRef && it.threadRef.kind === "paseo_agent");
    var ta = el("textarea");
    ta.id = "chatin-" + it.id;
    ta.rows = 2;
    ta.placeholder = "どこが分からないか書く";
    ta.value = loadDraft(it.id);
    ta.addEventListener("input", function () { saveDraft(it.id, ta.value); });
    var send = el("button", "primary", "送る");
    send.id = "chatsend-" + it.id;
    // 元スレが無い項目でも質問は記録され、応答ワーカーが返す(2026-10-22)。
    send.disabled = false;
    send.onclick = function () { sendChat(it); };
    box.appendChild(ta);
    box.appendChild(send);
    box.appendChild(el("div", "hint", canSendThread
      ? "元スレへ送られ、返答がここに出ます。元スレが作業中でも中断はしません(合流します)。"
      : "この項目には元スレの送り先がありませんが、書いた内容への返事はここに出ます。"));
    var log = el("div", "chatlog");
    log.id = "chatlog-" + it.id;
    box.appendChild(log);
    var st = el("div", "hint");
    st.id = "chatstatus-" + it.id;
    box.appendChild(st);
    box.appendChild(threadRow(it));
    return box;
  }

  function optionsBlock(it) {
    var box = el("div", "options");
    if (!it.options.length) {
      box.appendChild(el("div", "hint", "この項目は判断不要(参考)。読んだら既読にしてください。"));
      return box;
    }
    it.options.forEach(function (o) {
      var label = el("span");
      if (o.id === it.recommended) label.appendChild(el("span", "chip", "推奨"));
      label.appendChild(document.createTextNode(o.label));
      var b = el("button", o.id === it.recommended ? "rec" : "");
      b.appendChild(label);
      if (it.state !== "new") {
        b.disabled = true;  // 決着済み。何を選んだかは下の「決めた内容」に出る
        if (o.id === it.chosen) b.appendChild(el("span", "chip", "選択済み"));
      } else {
        b.onclick = function () { decide(it, "approve", o.id); };
      }
      box.appendChild(b);
    });
    return box;
  }

  function detailBlock(it) {
    var detail = el("div", "detail");
    if (it.summary) detail.appendChild(el("pre", "summary", it.summary));
    detail.appendChild(optionsBlock(it));

    if (it.background) {
      var bg = el("details", "bg");
      bg.appendChild(el("summary", "", "背景を開く"));
      bg.appendChild(el("pre", "", it.background));
      bg.open = Boolean(bgOpen[it.id] || (it.group && groupBg[it.group]));
      bg.addEventListener("toggle", function () {
        if (!bg.open) { bgOpen[it.id] = false; return; }
        bgOpen[it.id] = true;
        // 同じ group は背景を共有する: 1回開けば束の他の項目でも開いたままにし、
        // 選択肢だけ切り替えて連続で決められるようにする。
        if (it.group) groupBg[it.group] = true;
      });
      detail.appendChild(bg);
    } else {
      detail.appendChild(el("div", "hint", "背景は添付されていません"));
    }

    var ask = el("button", "", chatOpen[it.id] ? "チャット欄を閉じる" : "チャットで聞く");
    var chat = chatBlock(it);
    ask.onclick = function () {
      chatOpen[it.id] = !chatOpen[it.id];
      chat.hidden = !chatOpen[it.id];
      ask.textContent = chatOpen[it.id] ? "チャット欄を閉じる" : "チャットで聞く";
      if (chatOpen[it.id]) {
        var ta = document.getElementById("chatin-" + it.id);
        if (ta) ta.focus();
        loadChat(it);
      }
    };
    detail.appendChild(ask);
    detail.appendChild(chat);
    if (chatOpen[it.id]) renderChat(it);  // 再描画をまたいでも直近の内容を出しておく

    if (it.state === "new") {
      var bar = el("div", "bar");
      var read = el("button", "", "既読");
      read.onclick = function () { decide(it, "read"); };
      var ok = el("button", "primary", "承認");
      ok.onclick = function () { decide(it, "approve"); };
      bar.appendChild(read);
      bar.appendChild(ok);
      detail.appendChild(bar);
    } else {
      var what = it.chosen
        ? (it.options.filter(function (o) { return o.id === it.chosen; })[0] || {}).label || it.chosen
        : "";
      detail.appendChild(el("div", "decided",
        (it.state === "approved" ? "承認済み" : "既読") + (what ? " ・ 選んだ選択肢: " + what : "")));
    }
    return detail;
  }

  function render(data) {
    if (!data) return;
    lastData = data;
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
      // ① 一覧は題名だけ。推奨も本数も題名には詰め込まない(スマホの1行に入らない)。
      card.appendChild(el("div", "subject", it.subject));
      var row = el("div", "row");
      if (it.stoppedCount > 0) row.appendChild(el("span", "stop", it.stoppedCount + "件 停止中"));
      var toggle = el("button", "", expanded[it.id] ? "閉じる" : "開く");
      toggle.onclick = function () {
        expanded[it.id] = !expanded[it.id];
        render(lastData);  // 開閉は手元で描き直す(取り直すと待たされる)
      };
      row.appendChild(toggle);
      card.appendChild(row);
      if (expanded[it.id]) card.appendChild(detailBlock(it));
      listEl.appendChild(card);
    });
  }

  /** 入力中に描き直すと、打ちかけの文字とフォーカスが飛ぶ。返答の取り込みだけ進める。 */
  function isTyping() {
    var a = document.activeElement;
    return Boolean(a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT"));
  }

  function refreshChats(data) {
    (data.items || []).forEach(function (it) { if (chatOpen[it.id]) loadChat(it); });
  }

  function load() {
    return api("/items?view=" + (showAll.checked ? "all" : "active") + "&limit=200")
      .then(function (d) {
        statusEl.textContent = "更新 " + fmt(Date.now());
        statusEl.className = "meta";
        lastData = d;
        if (!isTyping()) render(d);
        refreshChats(d);
      })
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
