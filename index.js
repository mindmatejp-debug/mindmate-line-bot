const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PORT = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// =========================
// Utility
// =========================
function truncateText(text, maxLength = 4500) {
  return String(text || "").slice(0, maxLength);
}

function isTextMessageEvent(event) {
  return (
    event &&
    event.type === "message" &&
    event.message &&
    event.message.type === "text"
  );
}

function shouldAskClarifyingQuestions(userMessage) {
  const text = String(userMessage || "").trim();

  const shortText = text.length < 18;

  const vaguePatterns = [
    "どうしたらいい",
    "どうすればいい",
    "大丈夫",
    "違法",
    "問題ある",
    "相談したい",
    "見てほしい",
    "確認したい",
    "助けて",
    "トラブル",
    "困ってる"
  ];

  const hasVaguePattern = vaguePatterns.some((p) => text.includes(p));

  const detailSignals = [
    "契約",
    "書面",
    "口頭",
    "LINE",
    "メール",
    "金額",
    "円",
    "日付",
    "月",
    "日",
    "証拠",
    "請求",
    "未払い",
    "キャンセル",
    "相手",
    "取引先",
    "お客様",
    "業務委託",
    "文面",
    "文章"
  ];
  const detailCount = detailSignals.filter((p) => text.includes(p)).length;

  return shortText || (hasVaguePattern && detailCount < 2);
}

function detectReplyDraftMode(userMessage) {
  const text = String(userMessage || "");
  const patterns = [
    "文章作って",
    "文面作って",
    "返信文作って",
    "返信作って",
    "相手に送る文章",
    "相手に送る文面",
    "相手への返信",
    "送る文章を作って",
    "作成して"
  ];
  return patterns.some((p) => text.includes(p));
}

function estimateRiskLabel(userMessage) {
  const text = String(userMessage || "");

  const highRiskKeywords = [
    "訴訟",
    "裁判",
    "内容証明",
    "損害賠償",
    "未払い",
    "支払わない",
    "返金トラブル",
    "契約解除",
    "クーリングオフ",
    "違約金",
    "脅された",
    "法的措置",
    "差押え",
    "解雇",
    "懲戒",
    "告訴",
    "刑事"
  ];

  const mediumRiskKeywords = [
    "契約書",
    "キャンセル",
    "クレーム",
    "業務委託",
    "利用規約",
    "同意書",
    "請求",
    "返金",
    "著作権",
    "商標",
    "守秘義務",
    "誓約書"
  ];

  if (highRiskKeywords.some((k) => text.includes(k))) return "高リスク";
  if (mediumRiskKeywords.some((k) => text.includes(k))) return "中リスク";
  return "低リスク";
}

function buildClarifyingQuestionText(userMessage) {
  const risk = estimateRiskLabel(userMessage);

  return `まず精度を上げるため、先に確認させてください。
危険度目安：${risk}

次のうち、わかる範囲で教えてください。
1. 何が起きていますか？（一言で）
2. 相手は誰ですか？（お客様・取引先・業務委託先など）
3. 契約書や申込書、LINE、メールなどの証拠はありますか？
4. 口頭の約束ですか？書面がありますか？
5. 金額はいくらですか？
6. いつの出来事ですか？
7. 最終的にどうしたいですか？
   ・穏便に解決したい
   ・支払ってほしい
   ・契約をやめたい
   ・法的に問題あるか知りたい
   ・相手に送る文章を作ってほしい

この7点があると、かなり精度高く整理できます。`;
}

function buildLeoSystemPrompt() {
  return `
あなたは「法務顧問 レオ」です。
企業法務・契約・クレーム・未払い・業務委託トラブル対応に強い、冷静でロジカルな法務顧問AIです。

【あなたの役割】
- 契約ややり取りの法的リスクを整理する
- ユーザーが次に取るべき現実的な行動を示す
- 相手に送る返信文や確認事項のたたき台を作る
- 情報不足なら先にヒアリングして精度を高める
- 回答不能または不確実な場合は、無理に断定せず安全な代替案を出す
- 直近の会話履歴がある場合は、それを踏まえて一貫性のある回答をする

【絶対ルール】
- 間違った情報を断定しない
- 不確実な場合は「一般論では」「通常は」「個別事情によります」と明示する
- 最終的な法的判断は、契約書・証拠・時系列・地域差・最新法令で変わりうることを必要に応じて伝える
- 違法行為、脱法行為、脅迫的な文面の助言はしない
- 相手を煽る表現、威圧的な表現は避ける
- 日本語で回答する
- 難しすぎる法律用語はできるだけ避ける
- 上から目線にならず、信頼感のある口調にする
- 相手が今すぐ動ける内容にする
- わからない情報が多い時は、先に確認質問を優先する
- 緊急性が高い場合は、証拠保全や専門家相談を促す

【得意分野】
- 契約書確認
- キャンセル料
- 未払い請求
- 内容証明前の整理
- クレーム対応
- 業務委託トラブル
- 利用規約や同意文の叩き台
- 証拠整理
- 相手への返信文案

【危険度ラベル】
相談内容に応じて、必ず次のどれかを自然に入れてください。
- 低リスク
- 中リスク
- 高リスク

危険度は法的・実務的な深刻度の目安として示してください。

【通常回答の出力形式】
危険度：
結論：
理由：
確認したい点：
実務アドバイス：
注意点：

【確認質問モード】
情報不足なら、長文回答より先に必要事項を聞いてください。
特に次の情報を優先して確認してください。
- 契約書はあるか
- 口頭か書面か
- 金額
- 日付
- 証拠の有無
- 相手との関係
- 最終的にどうしたいか

【文案作成モード】
ユーザーが「相手に送る文章を作って」「返信文作って」と言った場合は、
次の3パターンを必ず出してください。
1. やわらかめ
2. 標準
3. 強めだが冷静

その際の出力形式は以下にしてください。
危険度：
前提整理：
文案（やわらかめ）：
文案（標準）：
文案（強めだが冷静）：
使うときの注意点：

【回答不能・即答困難時の対応】
次の場合は無理に断定せず、丁寧に不足情報や確認事項を案内してください。
- 情報不足
- 契約条文や証拠未確認
- 最新法改正確認が必要
- 裁判結果や違法性を断定できないケース

その場合は、
「現時点では断定は難しいです」
「精度を上げるため、次を教えてください」
のように案内してください。

【口調】
- 冷静
- 端的
- ロジカル
- ただし威圧的ではない
`;
}

// =========================
// Supabase: 保存
// =========================
async function saveMessage(userId, role, content) {
  try {
    if (!userId || !role || !content) return;

    const { error } = await supabase.from("messages").insert([
      {
        user_id: userId,
        role,
        content: String(content)
      }
    ]);

    if (error) {
      console.error("Supabase save error:", error.message);
    }
  } catch (error) {
    console.error("Supabase save exception:", error.message);
  }
}

// =========================
// Supabase: 履歴取得
// =========================
async function getRecentMessages(userId, limit = 8) {
  try {
    if (!userId) return [];

    const { data, error } = await supabase
      .from("messages")
      .select("role, content, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("Supabase fetch error:", error.message);
      return [];
    }

    return (data || [])
      .reverse()
      .map((msg) => ({
        role: msg.role,
        content: truncateText(msg.content, 1500)
      }))
      .filter((msg) => ["user", "assistant"].includes(msg.role));
  } catch (error) {
    console.error("Supabase fetch exception:", error.message);
    return [];
  }
}

async function callOpenAI(messages) {
  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      temperature: 0.35,
      messages
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 45000
    }
  );

  return response.data.choices?.[0]?.message?.content || "";
}

async function generateLeoReply(userId, userMessage) {
  const risk = estimateRiskLabel(userMessage);
  const needsClarifying = shouldAskClarifyingQuestions(userMessage);
  const isDraftMode = detectReplyDraftMode(userMessage);
  const history = await getRecentMessages(userId, 8);

  if (needsClarifying) {
    return buildClarifyingQuestionText(userMessage);
  }

  const systemPrompt = buildLeoSystemPrompt();

  let userPrompt = `
以下の相談に対して、法務顧問レオとして回答してください。
危険度は「${risk}」を基本目安として判断してください。
直近の会話履歴がある場合は、前後関係を踏まえて矛盾のない回答にしてください。
相談文：
${userMessage}
`;

  if (isDraftMode) {
    userPrompt += `
これは文案作成モードの可能性が高い相談です。
必要なら前提を短く整理した上で、
「やわらかめ」「標準」「強めだが冷静」の3パターンを出してください。`;
  }

  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userPrompt }
  ];

  const reply = await callOpenAI(messages);

  if (!reply) {
    return `現時点ではうまく回答を生成できませんでした。
恐れ入りますが、次の情報を整理してもう一度送ってください。

・相手は誰か
・何が起きているか
・契約書やLINEなどの証拠の有無
・金額
・日付
・最終的にどうしたいか`;
  }

  return reply;
}

async function replyToLine(replyToken, text) {
  const safeText = truncateText(text, 4500);

  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    {
      replyToken,
      messages: [{ type: "text", text: safeText }]
    },
    {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 15000
    }
  );
}

app.get("/", (req, res) => {
  res.status(200).send("Leo is running.");
});

app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events || [];

    for (const event of events) {
      try {
        if (!isTextMessageEvent(event)) continue;

        const userId = event.source?.userId;
        const userMessage = String(event.message.text || "").trim();
        if (!userMessage) continue;

        // ユーザー発言保存
        await saveMessage(userId, "user", userMessage);

        // AI生成
        const replyText = await generateLeoReply(userId, userMessage);

        // AI発言保存
        await saveMessage(userId, "assistant", replyText);

        // LINE返信
        await replyToLine(event.replyToken, replyText);
      } catch (eventError) {
        console.error(
          "Event handling error:",
          eventError.response?.data || eventError.message
        );

        try {
          const fallbackText = `すみません、今は正確な回答をすぐ返せない状態です。
精度を上げるため、次の内容を送ってください。

・何が起きているか
・相手は誰か
・契約書や証拠の有無
・金額
・日付
・最終的にどうしたいか

いただければ、改めて整理して回答します。`;

          await replyToLine(event.replyToken, fallbackText);

          const userId = event.source?.userId;
          if (userId) {
            await saveMessage(userId, "assistant", fallbackText);
          }
        } catch (replyError) {
          console.error(
            "Fallback reply error:",
            replyError.response?.data || replyError.message
          );
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error.response?.data || error.message);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
