import { useState, useEffect, useRef } from "react";

// --- helpers ----------------------------------------------------
const DAYS = ["日","月","火","水","木","金","土"];
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function pad(n){ return String(n).padStart(2,"0"); }
function fmtDate(k){
  const [y,m,d] = k.split("-");
  return `${+m}月${+d}日（${DAYS[new Date(+y,+m-1,+d).getDay()]}）`;
}

// --- Supabase client --------------------------------------------
const SUPA_URL = "https://uxwevkooivnepuzqzfdz.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV4d2V2a29vaXZuZXB1enF6ZmR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwNTE5MzMsImV4cCI6MjA4NzYyNzkzM30.FEOWSyZ4139D3BC_mQT8qyIocf2Yw8Xwa4NmbfIORNE";

async function sbFetch(path, opts={}) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      "apikey": SUPA_KEY,
      "Authorization": `Bearer ${SUPA_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
      ...(opts.headers||{})
    }
  });
  if (!res.ok) { const e = await res.text(); throw new Error(e); }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

// --- athlete roster (Supabase + localStorage fallback) ----------
function getRoster() {
  try { return JSON.parse(localStorage.getItem("bb_roster") || "[]"); }
  catch { return []; }
}
function saveRoster(roster) {
  localStorage.setItem("bb_roster", JSON.stringify(roster));
}
async function syncRosterToSupabase(athlete) {
  try {
    await sbFetch("roster", {
      method: "POST",
      body: JSON.stringify(athlete),
      headers: { "Prefer": "resolution=merge-duplicates,return=representation" }
    });
  } catch(e) { console.warn("Supabase roster sync failed", e); }
}
async function fetchRosterFromSupabase() {
  try {
    return await sbFetch("roster?select=*&order=created_at.asc");
  } catch(e) { console.warn("Supabase roster fetch failed", e); return []; }
}
function getRecords(athleteId) {
  try { return JSON.parse(localStorage.getItem(`bb_rec_${athleteId}`) || "{}"); }
  catch { return {}; }
}
function saveRecords(athleteId, data) {
  localStorage.setItem(`bb_rec_${athleteId}`, JSON.stringify(data));
}
async function syncRecordToSupabase(athlete, dateKey, record) {
  try {
    await sbFetch("records", {
      method: "POST",
      body: JSON.stringify({
        athlete_id: athlete.id,
        athlete_name: athlete.name,
        record_date: dateKey,
        data: record
      }),
      headers: { "Prefer": "resolution=merge-duplicates,return=representation" }
    });
  } catch(e) { console.warn("Supabase record sync failed", e); }
}
async function fetchAllRecordsFromSupabase() {
  try {
    return await sbFetch("records?select=*&order=record_date.desc");
  } catch(e) { console.warn("Supabase records fetch failed", e); return []; }
}
function calcKcal(rec) {
  if (!rec) return 0;
  let t = 0;
  if (rec.meals) Object.values(rec.meals).forEach(m => { t += parseFloat(m.kcal) || 0; });
  if (rec.snacks) rec.snacks.forEach(s => { t += parseFloat(s.kcal) || 0; });
  return t || (rec.calories ? parseInt(rec.calories) : 0);
}
function genId() { return "a" + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

// --- 高校球児向け目標摂取カロリー計算 ---------------------------
// Harris-Benedict式 + 運動強度係数（高校球児基準）
function calcTargetKcal(heightCm, weightKg, practiceHours, goal="maintain") {
  if (!heightCm || !weightKg) return null;
  const h = parseFloat(heightCm);
  const w = parseFloat(weightKg);
  if (isNaN(h) || isNaN(w) || h < 100 || w < 30) return null;
  // 基礎代謝（男性・17歳想定）Harris-Benedict式
  const bmr = 88.362 + (13.397 * w) + (4.799 * h) - (5.677 * 17);
  // 練習時間に応じた活動係数
  const ph = parseFloat(practiceHours) || 0;
  let factor;
  if (ph === 0)      factor = 1.55;
  else if (ph <= 1)  factor = 1.65;
  else if (ph <= 2)  factor = 1.75;
  else if (ph <= 3)  factor = 1.90;
  else if (ph <= 4)  factor = 2.05;
  else               factor = 2.20;
  const tdee = Math.round(bmr * factor); // 総消費カロリー
  // 目標別カロリー調整
  // 増量: +500kcal（週0.5kg増）、減量: -400kcal（週0.4kg減）
  const adj = goal === "bulk" ? 500 : goal === "cut" ? -400 : 0;
  const target = Math.round((tdee + adj) / 50) * 50;
  // PFC配分（目標別に調整）
  // 増量: タンパク質2.0g/kg、脂質25%、残り糖質
  // 減量: タンパク質2.2g/kg（筋肉保護）、脂質25%、残り糖質
  // 維持: タンパク質1.8g/kg、脂質25%、残り糖質
  const protRatio = goal === "bulk" ? 2.0 : goal === "cut" ? 2.2 : 1.8;
  const protein   = Math.round(w * protRatio);
  const protKcal  = protein * 4;
  const fatKcal   = Math.round(target * 0.25 / 10) * 10;
  const carbKcal  = Math.max(0, target - protKcal - fatKcal);
  const practiceLabel = ph === 0 ? "休養日" : ph <= 2 ? "通常練習" : ph <= 3.5 ? "ハード練習" : "超強化練習";
  const goalLabel = goal === "bulk" ? "増量" : goal === "cut" ? "減量" : "維持";
  const goalColor = goal === "bulk" ? "#e67e22" : goal === "cut" ? "#3498db" : "#2ecc71";
  const goalIcon  = goal === "bulk" ? "💪" : goal === "cut" ? "🔥" : "⚖️";
  const goalTip   = goal === "bulk"
    ? `TDEE ${tdee.toLocaleString()}kcal + 500kcal（週約0.5kg増量ペース）`
    : goal === "cut"
    ? `TDEE ${tdee.toLocaleString()}kcal - 400kcal（週約0.4kg減量ペース）`
    : `TDEE ${tdee.toLocaleString()}kcal（体重維持）`;
  return {
    target, protein, protKcal, fatKcal, carbKcal,
    carb: Math.round(carbKcal / 4),
    fat:  Math.round(fatKcal / 9),
    tdee, adj, practiceLabel, goalLabel, goalColor, goalIcon, goalTip,
  };
}

// --- constants --------------------------------------------------
const FATIGUE_LABELS = ["絶好調 💪","良好 😊","普通 😐","疲れ気味 😓","限界 🆘"];
const FATIGUE_COLORS = ["#2ecc71","#8bc34a","#f0c040","#e67e22","#e74c3c"];
const FATIGUE_BG     = ["#1a3d2b","#253020","#3a3010","#3d2010","#3a1015"];
const POSITIONS      = ["投手","捕手","内野手","外野手","指名打者","その他"];
const QUICK_SNACKS   = ["プロテイン","おにぎり","バナナ","サプリ","エネルギーゼリー","アミノ酸"];
const MEAL_META = [
  {key:"morning", label:"朝ごはん", icon:"🌅"},
  {key:"lunch",   label:"昼ごはん", icon:"☀️"},
  {key:"dinner",  label:"夜ごはん", icon:"🌙"},
];

// --- data shapes ------------------------------------------------
const emptyMeal  = () => ({ menuText:"", kcal:"", note:"", items:[], img:null, busy:false });
const emptySnack = (label="") => ({ label, menuText:label, kcal:"", note:"", items:[], img:null, busy:false });
const emptyRecord = () => ({
  weight:"", sleep:"", fatigue:2,
  meals:{ morning:emptyMeal(), lunch:emptyMeal(), dinner:emptyMeal() },
  snacks:[], practice:"", memo:"", pain:[], saved:false,
});

// --- pain body parts ---------------------------------------------
const BODY_PARTS = [
  {id:"head",       label:"頭",          x:50, y:4,  side:"front"},
  {id:"neck",       label:"首",          x:50, y:11, side:"front"},
  {id:"l_shoulder", label:"左肩",        x:33, y:17, side:"front"},
  {id:"r_shoulder", label:"右肩",        x:67, y:17, side:"front"},
  {id:"chest",      label:"胸",          x:50, y:22, side:"front"},
  {id:"l_elbow",    label:"左肘",        x:27, y:30, side:"front"},
  {id:"r_elbow",    label:"右肘",        x:73, y:30, side:"front"},
  {id:"abdomen",    label:"腹",          x:50, y:32, side:"front"},
  {id:"l_wrist",    label:"左手首",      x:22, y:41, side:"front"},
  {id:"r_wrist",    label:"右手首",      x:78, y:41, side:"front"},
  {id:"l_hip",      label:"左股関節",    x:38, y:50, side:"front"},
  {id:"r_hip",      label:"右股関節",    x:62, y:50, side:"front"},
  {id:"l_knee",     label:"左膝",        x:38, y:68, side:"front"},
  {id:"r_knee",     label:"右膝",        x:62, y:68, side:"front"},
  {id:"l_ankle",    label:"左足首",      x:38, y:84, side:"front"},
  {id:"r_ankle",    label:"右足首",      x:62, y:84, side:"front"},
  {id:"upper_back", label:"上背部",      x:50, y:20, side:"back"},
  {id:"lower_back", label:"腰",          x:50, y:34, side:"back"},
  {id:"l_hamstring",label:"左ハムスト",  x:38, y:62, side:"back"},
  {id:"r_hamstring",label:"右ハムスト",  x:62, y:62, side:"back"},
  {id:"l_calf",     label:"左ふくらはぎ",x:38, y:77, side:"back"},
  {id:"r_calf",     label:"右ふくらはぎ",x:62, y:77, side:"back"},
];
const PAIN_LEVELS = ["軽い","中程度","強い","激しい"];
const PAIN_COLORS = ["#f0c040","#e67e22","#e74c3c","#8e0000"];

// --- 食品カロリーDB（文部科学省 日本食品標準成分表2020八訂より） ----
// 単位: 100gあたりkcal / 1食あたりの目安量(g)も記載
const FOOD_DB = [
  // ══ 主食・ご飯類 ══
  {n:"ご飯（白米）",          unit:"茶碗1杯(150g)",   g:150, k:252, cat:"主食"},
  {n:"ご飯（大盛）",          unit:"茶碗1杯(220g)",   g:220, k:370, cat:"主食"},
  {n:"ご飯（小盛）",          unit:"茶碗1杯(100g)",   g:100, k:168, cat:"主食"},
  {n:"ご飯（特盛）",          unit:"茶碗1杯(300g)",   g:300, k:504, cat:"主食"},
  {n:"雑穀米",                unit:"茶碗1杯(150g)",   g:150, k:248, cat:"主食"},
  {n:"玄米ご飯",              unit:"茶碗1杯(150g)",   g:150, k:248, cat:"主食"},
  {n:"赤飯",                  unit:"茶碗1杯(150g)",   g:150, k:282, cat:"主食"},
  {n:"チャーハン",             unit:"1皿(350g)",       g:350, k:578, cat:"主食"},
  {n:"おじや・雑炊",           unit:"1杯(300g)",       g:300, k:210, cat:"主食"},
  {n:"リゾット",               unit:"1皿(300g)",       g:300, k:420, cat:"主食"},
  // -- おにぎり --
  {n:"おにぎり（シャケ）",     unit:"1個(120g)",       g:120, k:201, cat:"主食"},
  {n:"おにぎり（梅）",         unit:"1個(100g)",       g:100, k:165, cat:"主食"},
  {n:"おにぎり（ツナマヨ）",   unit:"1個(110g)",       g:110, k:221, cat:"主食"},
  {n:"おにぎり（昆布）",       unit:"1個(100g)",       g:100, k:168, cat:"主食"},
  {n:"おにぎり（明太子）",     unit:"1個(110g)",       g:110, k:185, cat:"主食"},
  {n:"おにぎり（唐揚げ）",     unit:"1個(130g)",       g:130, k:260, cat:"主食"},
  {n:"おにぎり（天むす）",     unit:"1個(120g)",       g:120, k:230, cat:"主食"},
  {n:"おにぎり（焼きおにぎり）",unit:"1個(120g)",      g:120, k:210, cat:"主食"},
  // -- パン類 --
  {n:"食パン（6枚切）",        unit:"1枚(60g)",        g:60,  k:158, cat:"主食"},
  {n:"食パン（8枚切）",        unit:"1枚(45g)",        g:45,  k:119, cat:"主食"},
  {n:"食パン（4枚切）",        unit:"1枚(90g)",        g:90,  k:237, cat:"主食"},
  {n:"フランスパン",            unit:"1切(60g)",        g:60,  k:167, cat:"主食"},
  {n:"クロワッサン",            unit:"1個(45g)",        g:45,  k:197, cat:"主食"},
  {n:"ロールパン",              unit:"1個(30g)",        g:30,  k:93,  cat:"主食"},
  {n:"メロンパン",              unit:"1個(90g)",        g:90,  k:349, cat:"主食"},
  {n:"あんパン",                unit:"1個(100g)",       g:100, k:280, cat:"主食"},
  {n:"カレーパン",              unit:"1個(100g)",       g:100, k:320, cat:"主食"},
  {n:"チーズバーガー",          unit:"1個(130g)",       g:130, k:310, cat:"主食"},
  {n:"ホットドッグ",            unit:"1個(150g)",       g:150, k:340, cat:"主食"},
  {n:"サンドイッチ（ハム）",    unit:"1個(130g)",       g:130, k:270, cat:"主食"},
  {n:"サンドイッチ（ツナ）",    unit:"1個(130g)",       g:130, k:290, cat:"主食"},
  {n:"サンドイッチ（たまご）",  unit:"1個(130g)",       g:130, k:299, cat:"主食"},
  {n:"バゲット",                unit:"1切(80g)",        g:80,  k:222, cat:"主食"},
  {n:"ベーグル",                unit:"1個(100g)",       g:100, k:270, cat:"主食"},
  {n:"イングリッシュマフィン",  unit:"1個(60g)",        g:60,  k:150, cat:"主食"},
  {n:"ナン",                    unit:"1枚(100g)",       g:100, k:262, cat:"主食"},
  // -- 麺類 --
  {n:"うどん（茹で）",          unit:"1玉(200g)",       g:200, k:210, cat:"主食"},
  {n:"そば（茹で）",            unit:"1玉(200g)",       g:200, k:264, cat:"主食"},
  {n:"ラーメン",                unit:"1杯(550g)",       g:550, k:501, cat:"主食"},
  {n:"醤油ラーメン",            unit:"1杯(500g)",       g:500, k:470, cat:"主食"},
  {n:"味噌ラーメン",            unit:"1杯(550g)",       g:550, k:540, cat:"主食"},
  {n:"豚骨ラーメン",            unit:"1杯(550g)",       g:550, k:580, cat:"主食"},
  {n:"つけ麺",                  unit:"1杯(350g)",       g:350, k:510, cat:"主食"},
  {n:"うどん（かけ）",          unit:"1杯(400g)",       g:400, k:310, cat:"主食"},
  {n:"うどん（天ぷら）",        unit:"1杯(500g)",       g:500, k:530, cat:"主食"},
  {n:"うどん（肉）",            unit:"1杯(500g)",       g:500, k:480, cat:"主食"},
  {n:"うどん（釜玉）",          unit:"1杯(350g)",       g:350, k:420, cat:"主食"},
  {n:"そば（もり）",            unit:"1杯(200g)",       g:200, k:264, cat:"主食"},
  {n:"そば（天ぷら）",          unit:"1杯(450g)",       g:450, k:620, cat:"主食"},
  {n:"そば（かけ）",            unit:"1杯(400g)",       g:400, k:310, cat:"主食"},
  {n:"パスタ（ペスカトーレ）",  unit:"1皿(380g)",       g:380, k:540, cat:"主食"},
  {n:"パスタ（アラビアータ）",  unit:"1皿(350g)",       g:350, k:490, cat:"主食"},
  {n:"パスタ（バジルソース）",  unit:"1皿(350g)",       g:350, k:520, cat:"主食"},
  {n:"パスタ（ボンゴレ）",      unit:"1皿(380g)",       g:380, k:490, cat:"主食"},
  {n:"塩ラーメン",              unit:"1杯(500g)",       g:500, k:440, cat:"主食"},
  {n:"担々麺",                  unit:"1杯(550g)",       g:550, k:650, cat:"主食"},
  {n:"まぜそば",                unit:"1杯(400g)",       g:400, k:620, cat:"主食"},
  {n:"焼きそば",                unit:"1皿(400g)",       g:400, k:548, cat:"主食"},
  {n:"パスタ（ゆで）",          unit:"1人前(250g)",     g:250, k:373, cat:"主食"},
  {n:"スパゲッティミートソース",unit:"1皿(400g)",       g:400, k:640, cat:"主食"},
  {n:"カルボナーラ",            unit:"1皿(400g)",       g:400, k:760, cat:"主食"},
  {n:"ペペロンチーノ",          unit:"1皿(350g)",       g:350, k:530, cat:"主食"},
  {n:"ナポリタン",              unit:"1皿(400g)",       g:400, k:580, cat:"主食"},
  {n:"冷やし中華",              unit:"1皿(350g)",       g:350, k:430, cat:"主食"},
  {n:"そうめん（茹で）",        unit:"1束(200g)",       g:200, k:286, cat:"主食"},
  {n:"冷やしそうめん",          unit:"1人前(200g)",     g:200, k:286, cat:"主食"},
  {n:"ビーフン",                unit:"1人前(200g)",     g:200, k:280, cat:"主食"},
  {n:"カップラーメン",          unit:"1個(80g乾燥)",    g:80,  k:338, cat:"主食"},
  {n:"カップ焼きそば",          unit:"1個(130g)",       g:130, k:490, cat:"主食"},
  // -- 丼・定食 --
  {n:"カレーライス",            unit:"1皿(700g)",       g:700, k:910, cat:"主食"},
  {n:"カツカレー",              unit:"1皿(800g)",       g:800, k:1100,cat:"主食"},
  {n:"親子丼",                  unit:"1杯(500g)",       g:500, k:680, cat:"主食"},
  {n:"牛丼（並）",              unit:"1杯(352g)",       g:352, k:633, cat:"主食"},
  {n:"牛丼（大盛）",            unit:"1杯(450g)",       g:450, k:810, cat:"主食"},
  {n:"豚丼",                    unit:"1杯(400g)",       g:400, k:650, cat:"主食"},
  {n:"天丼",                    unit:"1杯(450g)",       g:450, k:720, cat:"主食"},
  {n:"うな丼",                  unit:"1杯(400g)",       g:400, k:680, cat:"主食"},
  {n:"海鮮丼",                  unit:"1杯(400g)",       g:400, k:520, cat:"主食"},
  {n:"まぐろ丼",                unit:"1杯(350g)",       g:350, k:450, cat:"主食"},
  {n:"鮭いくら丼",              unit:"1杯(400g)",       g:400, k:580, cat:"主食"},
  {n:"カツ丼",                  unit:"1杯(550g)",       g:550, k:850, cat:"主食"},
  {n:"炒飯定食",                unit:"1人前(600g)",     g:600, k:850, cat:"主食"},
  // ══ 肉類 ══
  {n:"鶏むね肉（皮なし）",      unit:"1枚(200g)",       g:200, k:222, cat:"肉"},
  {n:"鶏むね肉（皮あり）",      unit:"1枚(200g)",       g:200, k:304, cat:"肉"},
  {n:"鶏もも肉（皮なし）",      unit:"1枚(200g)",       g:200, k:234, cat:"肉"},
  {n:"鶏もも肉（皮あり）",      unit:"1枚(200g)",       g:200, k:400, cat:"肉"},
  {n:"鶏ささみ",                unit:"1本(50g)",        g:50,  k:58,  cat:"肉"},
  {n:"鶏手羽元",                unit:"2本(100g)",       g:100, k:197, cat:"肉"},
  {n:"鶏手羽先",                unit:"2本(100g)",       g:100, k:226, cat:"肉"},
  {n:"唐揚げ",                  unit:"1個(40g)",        g:40,  k:107, cat:"肉"},
  {n:"唐揚げ（3個）",           unit:"3個(120g)",       g:120, k:321, cat:"肉"},
  {n:"チキンステーキ",          unit:"1枚(200g)",       g:200, k:340, cat:"肉"},
  {n:"焼き鳥（もも）",          unit:"1本(40g)",        g:40,  k:80,  cat:"肉"},
  {n:"焼き鳥（ねぎま）",        unit:"1本(40g)",        g:40,  k:72,  cat:"肉"},
  {n:"焼き鳥（皮）",            unit:"1本(30g)",        g:30,  k:90,  cat:"肉"},
  {n:"焼き鳥（つくね）",        unit:"1本(50g)",        g:50,  k:95,  cat:"肉"},
  {n:"豚ロース",                unit:"1枚(100g)",       g:100, k:263, cat:"肉"},
  {n:"豚バラ",                  unit:"100g",            g:100, k:395, cat:"肉"},
  {n:"豚ヒレ",                  unit:"100g",            g:100, k:130, cat:"肉"},
  {n:"豚こま切れ",              unit:"100g",            g:100, k:228, cat:"肉"},
  {n:"とんかつ",                unit:"1枚(150g)",       g:150, k:428, cat:"肉"},
  {n:"ヒレカツ",                unit:"1枚(120g)",       g:120, k:290, cat:"肉"},
  {n:"生姜焼き",                unit:"1人前(150g)",     g:150, k:340, cat:"肉"},
  {n:"豚の角煮",                unit:"1人前(150g)",     g:150, k:420, cat:"肉"},
  {n:"酢豚",                    unit:"1人前(200g)",     g:200, k:380, cat:"肉"},
  {n:"牛ロース",                unit:"100g",            g:100, k:380, cat:"肉"},
  {n:"牛もも",                  unit:"100g",            g:100, k:235, cat:"肉"},
  {n:"牛バラ",                  unit:"100g",            g:100, k:472, cat:"肉"},
  {n:"牛ヒレ",                  unit:"100g",            g:100, k:195, cat:"肉"},
  {n:"ステーキ（サーロイン）",  unit:"1枚(200g)",       g:200, k:760, cat:"肉"},
  {n:"ステーキ（ヒレ）",        unit:"1枚(200g)",       g:200, k:390, cat:"肉"},
  {n:"ハンバーグ",              unit:"1個(150g)",       g:150, k:296, cat:"肉"},
  {n:"ハンバーグ（デミグラス）",unit:"1人前(200g)",     g:200, k:420, cat:"肉"},
  {n:"ミートボール",            unit:"5個(100g)",       g:100, k:200, cat:"肉"},
  {n:"焼き肉（カルビ）",        unit:"100g",            g:100, k:395, cat:"肉"},
  {n:"焼き肉（ロース）",        unit:"100g",            g:100, k:285, cat:"肉"},
  {n:"焼き肉（ハラミ）",        unit:"100g",            g:100, k:240, cat:"肉"},
  {n:"焼き肉（タン）",          unit:"100g",            g:100, k:269, cat:"肉"},
  {n:"ウインナー",              unit:"2本(34g)",        g:34,  k:101, cat:"肉"},
  {n:"フランクフルト",          unit:"1本(70g)",        g:70,  k:197, cat:"肉"},
  {n:"ベーコン",                unit:"2枚(40g)",        g:40,  k:162, cat:"肉"},
  {n:"ハム（ロース）",          unit:"2枚(40g)",        g:40,  k:83,  cat:"肉"},
  {n:"コーンビーフ",            unit:"1/2缶(50g)",      g:50,  k:102, cat:"肉"},
  {n:"牛肉（薄切り）",          unit:"100g",            g:100, k:209, cat:"肉"},
  {n:"牛肉（こま切れ）",        unit:"100g",            g:100, k:251, cat:"肉"},
  {n:"牛肉（切り落とし）",      unit:"100g",            g:100, k:295, cat:"肉"},
  {n:"牛肉（すき焼き用）",      unit:"100g",            g:100, k:344, cat:"肉"},
  {n:"牛すき焼き",              unit:"1人前(250g)",     g:250, k:450, cat:"肉"},
  {n:"牛しゃぶしゃぶ",          unit:"1人前(200g)",     g:200, k:340, cat:"肉"},
  {n:"牛肉の煮込み",            unit:"1人前(200g)",     g:200, k:380, cat:"肉"},
  {n:"ローストビーフ",          unit:"4切(80g)",        g:80,  k:186, cat:"肉"},
  {n:"ビーフシチュー",          unit:"1皿(300g)",       g:300, k:390, cat:"肉"},
  {n:"豚肉（薄切り）",          unit:"100g",            g:100, k:216, cat:"肉"},
  {n:"豚肉（こま切れ）",        unit:"100g",            g:100, k:228, cat:"肉"},
  {n:"豚肉（切り落とし）",      unit:"100g",            g:100, k:235, cat:"肉"},
  {n:"豚肉（すき焼き用）",      unit:"100g",            g:100, k:263, cat:"肉"},
  {n:"豚しゃぶしゃぶ",          unit:"1人前(200g)",     g:200, k:380, cat:"肉"},
  {n:"豚の塩焼き",              unit:"1人前(150g)",     g:150, k:345, cat:"肉"},
  {n:"豚みそ漬け",              unit:"1枚(100g)",       g:100, k:248, cat:"肉"},
  {n:"スペアリブ",              unit:"2本(150g)",       g:150, k:410, cat:"肉"},
  {n:"ミートソース",            unit:"1人前(150g)",     g:150, k:210, cat:"肉"},
  {n:"餃子",                    unit:"5個(100g)",       g:100, k:191, cat:"肉"},
  {n:"シュウマイ",              unit:"5個(100g)",       g:100, k:199, cat:"肉"},
  {n:"春巻き",                  unit:"2本(100g)",       g:100, k:230, cat:"肉"},
  // ══ 魚介・卵・大豆 ══
  {n:"サバ（焼き）",            unit:"1切(100g)",       g:100, k:220, cat:"魚"},
  {n:"サバ缶（水煮）",          unit:"1缶(190g)",       g:190, k:299, cat:"魚"},
  {n:"サバ缶（味噌煮）",        unit:"1缶(190g)",       g:190, k:342, cat:"魚"},
  {n:"サーモン（刺身）",        unit:"5切(100g)",       g:100, k:204, cat:"魚"},
  {n:"サーモン（焼き）",        unit:"1切(100g)",       g:100, k:220, cat:"魚"},
  {n:"マグロ（赤身刺身）",      unit:"5切(100g)",       g:100, k:125, cat:"魚"},
  {n:"マグロ（中トロ刺身）",    unit:"5切(100g)",       g:100, k:221, cat:"魚"},
  {n:"ツナ缶（水煮）",          unit:"1缶(70g)",        g:70,  k:56,  cat:"魚"},
  {n:"ツナ缶（油漬）",          unit:"1缶(70g)",        g:70,  k:189, cat:"魚"},
  {n:"サンマ（焼き）",          unit:"1尾(150g)",       g:150, k:329, cat:"魚"},
  {n:"アジ（焼き）",            unit:"1尾(100g)",       g:100, k:148, cat:"魚"},
  {n:"アジの南蛮漬け",          unit:"1人前(150g)",     g:150, k:210, cat:"魚"},
  {n:"イワシ（焼き）",          unit:"2尾(100g)",       g:100, k:177, cat:"魚"},
  {n:"ブリ（照り焼き）",        unit:"1切(100g)",       g:100, k:257, cat:"魚"},
  {n:"鮭（塩焼き）",            unit:"1切(100g)",       g:100, k:166, cat:"魚"},
  {n:"鮭（ムニエル）",          unit:"1切(120g)",       g:120, k:250, cat:"魚"},
  {n:"鮭（ちゃんちゃん焼き）",  unit:"1人前(200g)",     g:200, k:320, cat:"魚"},
  {n:"鮭フレーク",              unit:"大さじ2(20g)",    g:20,  k:38,  cat:"魚"},
  {n:"銀鮭（焼き）",            unit:"1切(100g)",       g:100, k:204, cat:"魚"},
  {n:"鮭の西京焼き",            unit:"1切(100g)",       g:100, k:185, cat:"魚"},
  {n:"タラの塩焼き",            unit:"1切(100g)",       g:100, k:77,  cat:"魚"},
  {n:"サバの塩焼き",            unit:"1切(100g)",       g:100, k:211, cat:"魚"},
  {n:"アジの塩焼き",            unit:"1尾(100g)",       g:100, k:148, cat:"魚"},
  {n:"サンマの塩焼き",          unit:"1尾(150g)",       g:150, k:287, cat:"魚"},
  {n:"ブリの塩焼き",            unit:"1切(100g)",       g:100, k:222, cat:"魚"},
  {n:"カツオの刺身",            unit:"5切(100g)",       g:100, k:114, cat:"魚"},
  {n:"ヒラメの刺身",            unit:"5切(100g)",       g:100, k:103, cat:"魚"},
  {n:"タイの刺身",              unit:"5切(100g)",       g:100, k:142, cat:"魚"},
  {n:"タラ（焼き）",            unit:"1切(100g)",       g:100, k:77,  cat:"魚"},
  {n:"タラ（フライ）",          unit:"1切(120g)",       g:120, k:230, cat:"魚"},
  {n:"カレイ（煮つけ）",        unit:"1切(100g)",       g:100, k:118, cat:"魚"},
  {n:"エビフライ",              unit:"2尾(100g)",       g:100, k:210, cat:"魚"},
  {n:"エビ（ゆで）",            unit:"5尾(100g)",       g:100, k:98,  cat:"魚"},
  {n:"エビチリ",                unit:"1人前(150g)",     g:150, k:195, cat:"魚"},
  {n:"イカ（刺身）",            unit:"100g",            g:100, k:83,  cat:"魚"},
  {n:"イカ（焼き）",            unit:"1杯(150g)",       g:150, k:143, cat:"魚"},
  {n:"タコ（茹で）",            unit:"100g",            g:100, k:76,  cat:"魚"},
  {n:"ホタテ（焼き）",          unit:"3個(100g)",       g:100, k:97,  cat:"魚"},
  {n:"アサリ（酒蒸し）",        unit:"1人前(100g)",     g:100, k:30,  cat:"魚"},
  {n:"カキフライ",              unit:"3個(100g)",       g:100, k:225, cat:"魚"},
  {n:"魚肉ソーセージ",          unit:"1本(90g)",        g:90,  k:135, cat:"魚"},
  {n:"かまぼこ",                unit:"4切(60g)",        g:60,  k:56,  cat:"魚"},
  {n:"ちくわ",                  unit:"2本(60g)",        g:60,  k:74,  cat:"魚"},
  {n:"はんぺん",                unit:"1枚(100g)",       g:100, k:94,  cat:"魚"},
  {n:"さつま揚げ",              unit:"2枚(100g)",       g:100, k:139, cat:"魚"},
  // -- 卵 --
  {n:"ゆで卵",                  unit:"1個(50g)",        g:50,  k:76,  cat:"魚"},
  {n:"目玉焼き",                unit:"1個(60g)",        g:60,  k:99,  cat:"魚"},
  {n:"スクランブルエッグ",      unit:"2個分(120g)",     g:120, k:200, cat:"魚"},
  {n:"卵焼き",                  unit:"1人前(100g)",     g:100, k:185, cat:"魚"},
  {n:"オムレツ",                unit:"1個(150g)",       g:150, k:255, cat:"魚"},
  {n:"オムライス",              unit:"1皿(400g)",       g:400, k:620, cat:"魚"},
  {n:"茶碗蒸し",                unit:"1個(150g)",       g:150, k:75,  cat:"魚"},
  {n:"温泉卵",                  unit:"1個(50g)",        g:50,  k:71,  cat:"魚"},
  // -- 大豆・豆腐 --
  {n:"納豆",                    unit:"1パック(45g)",    g:45,  k:86,  cat:"魚"},
  {n:"豆腐（絹ごし）",          unit:"1/2丁(150g)",    g:150, k:84,  cat:"魚"},
  {n:"豆腐（木綿）",            unit:"1/2丁(150g)",    g:150, k:108, cat:"魚"},
  {n:"冷奴",                    unit:"1丁(150g)",       g:150, k:84,  cat:"魚"},
  {n:"麻婆豆腐",                unit:"1人前(250g)",     g:250, k:280, cat:"魚"},
  {n:"揚げ出し豆腐",            unit:"1人前(200g)",     g:200, k:220, cat:"魚"},
  {n:"厚揚げ",                  unit:"1/2枚(100g)",    g:100, k:150, cat:"魚"},
  {n:"油揚げ",                  unit:"1枚(30g)",        g:30,  k:111, cat:"魚"},
  {n:"湯豆腐",                  unit:"1人前(200g)",     g:200, k:112, cat:"魚"},
  {n:"豆乳（無調整）",          unit:"200ml",           g:200, k:88,  cat:"魚"},
  {n:"豆乳（調整）",            unit:"200ml",           g:200, k:126, cat:"魚"},
  {n:"枝豆",                    unit:"1/2袋(100g)",    g:100, k:135, cat:"魚"},
  // ══ 野菜・副菜 ══
  {n:"味噌汁",                  unit:"1杯(150g)",       g:150, k:30,  cat:"副菜"},
  {n:"豚汁",                    unit:"1杯(200g)",       g:200, k:120, cat:"副菜"},
  {n:"野菜サラダ",              unit:"1皿(100g)",       g:100, k:23,  cat:"副菜"},
  {n:"シーザーサラダ",          unit:"1皿(150g)",       g:150, k:180, cat:"副菜"},
  {n:"ほうれん草（茹で）",      unit:"1束(100g)",       g:100, k:25,  cat:"副菜"},
  {n:"ほうれん草のおひたし",    unit:"1人前(80g)",      g:80,  k:20,  cat:"副菜"},
  {n:"ブロッコリー（茹で）",    unit:"5房(100g)",       g:100, k:33,  cat:"副菜"},
  {n:"トマト",                  unit:"中1個(150g)",     g:150, k:29,  cat:"副菜"},
  {n:"ミニトマト",              unit:"10個(100g)",      g:100, k:29,  cat:"副菜"},
  {n:"きゅうり",                unit:"1本(100g)",       g:100, k:14,  cat:"副菜"},
  {n:"もやし（炒め）",          unit:"1人前(100g)",     g:100, k:56,  cat:"副菜"},
  {n:"キャベツ",                unit:"1枚(50g)",        g:50,  k:12,  cat:"副菜"},
  {n:"千切りキャベツ",          unit:"1皿(80g)",        g:80,  k:19,  cat:"副菜"},
  {n:"ポテトサラダ",            unit:"1皿(100g)",       g:100, k:121, cat:"副菜"},
  {n:"マカロニサラダ",          unit:"1皿(100g)",       g:100, k:148, cat:"副菜"},
  {n:"きんぴらごぼう",          unit:"1人前(80g)",      g:80,  k:89,  cat:"副菜"},
  {n:"ひじき煮",                unit:"1人前(60g)",      g:60,  k:42,  cat:"副菜"},
  {n:"切り干し大根",            unit:"1人前(60g)",      g:60,  k:52,  cat:"副菜"},
  {n:"かぼちゃの煮物",          unit:"1人前(100g)",     g:100, k:91,  cat:"副菜"},
  {n:"肉じゃが",                unit:"1人前(200g)",     g:200, k:230, cat:"副菜"},
  {n:"筑前煮",                  unit:"1人前(150g)",     g:150, k:165, cat:"副菜"},
  {n:"ラタトゥイユ",            unit:"1人前(150g)",     g:150, k:90,  cat:"副菜"},
  {n:"コーン（缶）",            unit:"大さじ2(30g)",    g:30,  k:25,  cat:"副菜"},
  {n:"ゴーヤチャンプル",        unit:"1人前(200g)",     g:200, k:220, cat:"副菜"},
  {n:"ニラ玉",                  unit:"1人前(150g)",     g:150, k:200, cat:"副菜"},
  {n:"ほうれん草のバター炒め",  unit:"1人前(100g)",     g:100, k:85,  cat:"副菜"},
  {n:"なすの揚げびたし",        unit:"1人前(150g)",     g:150, k:130, cat:"副菜"},
  {n:"春菊のごま和え",          unit:"1人前(80g)",      g:80,  k:65,  cat:"副菜"},
  {n:"白菜の浅漬け",            unit:"1人前(80g)",      g:80,  k:18,  cat:"副菜"},
  {n:"タコのマリネ",            unit:"1人前(100g)",     g:100, k:95,  cat:"副菜"},
  {n:"カプレーゼ",              unit:"1皿(150g)",       g:150, k:170, cat:"副菜"},
  {n:"アボカドサラダ",          unit:"1皿(150g)",       g:150, k:200, cat:"副菜"},
  // ══ 乳製品 ══
  {n:"牛乳",                    unit:"コップ1杯(200ml)",g:200, k:134, cat:"乳製品"},
  {n:"低脂肪牛乳",              unit:"コップ1杯(200ml)",g:200, k:92,  cat:"乳製品"},
  {n:"無脂肪牛乳",              unit:"コップ1杯(200ml)",g:200, k:70,  cat:"乳製品"},
  {n:"ヨーグルト（無糖）",      unit:"1カップ(100g)",   g:100, k:62,  cat:"乳製品"},
  {n:"ヨーグルト（加糖）",      unit:"1カップ(100g)",   g:100, k:87,  cat:"乳製品"},
  {n:"ギリシャヨーグルト",      unit:"1カップ(100g)",   g:100, k:59,  cat:"乳製品"},
  {n:"飲むヨーグルト",          unit:"1本(200ml)",      g:200, k:130, cat:"乳製品"},
  {n:"チーズ（スライス）",      unit:"1枚(18g)",        g:18,  k:61,  cat:"乳製品"},
  {n:"カッテージチーズ",        unit:"大さじ2(50g)",    g:50,  k:50,  cat:"乳製品"},
  {n:"モッツァレラチーズ",      unit:"1/2個(60g)",     g:60,  k:160, cat:"乳製品"},
  {n:"クリームチーズ",          unit:"大さじ1(20g)",    g:20,  k:69,  cat:"乳製品"},
  {n:"パルメザンチーズ",        unit:"大さじ1(6g)",     g:6,   k:26,  cat:"乳製品"},
  {n:"バター",                  unit:"大さじ1(12g)",    g:12,  k:89,  cat:"乳製品"},
  {n:"マーガリン",              unit:"大さじ1(12g)",    g:12,  k:89,  cat:"乳製品"},
  {n:"生クリーム",              unit:"大さじ2(30ml)",   g:30,  k:126, cat:"乳製品"},
  // ══ 果物 ══
  {n:"バナナ",                  unit:"1本(100g)",       g:100, k:86,  cat:"果物"},
  {n:"バナナ（2本）",           unit:"2本(200g)",       g:200, k:172, cat:"果物"},
  {n:"りんご",                  unit:"中1/2個(150g)",   g:150, k:87,  cat:"果物"},
  {n:"みかん",                  unit:"中1個(100g)",     g:100, k:46,  cat:"果物"},
  {n:"いちご",                  unit:"10粒(150g)",      g:150, k:51,  cat:"果物"},
  {n:"ぶどう",                  unit:"10粒(100g)",      g:100, k:59,  cat:"果物"},
  {n:"キウイ",                  unit:"1個(100g)",       g:100, k:53,  cat:"果物"},
  {n:"もも",                    unit:"中1個(200g)",     g:200, k:80,  cat:"果物"},
  {n:"メロン",                  unit:"1/4個(200g)",    g:200, k:68,  cat:"果物"},
  {n:"スイカ",                  unit:"1切(200g)",       g:200, k:74,  cat:"果物"},
  {n:"パイナップル",            unit:"2切(100g)",       g:100, k:51,  cat:"果物"},
  {n:"マンゴー",                unit:"1/2個(150g)",    g:150, k:99,  cat:"果物"},
  {n:"グレープフルーツ",        unit:"1/2個(150g)",    g:150, k:57,  cat:"果物"},
  {n:"レモン",                  unit:"1/2個(50g)",     g:50,  k:19,  cat:"果物"},
  {n:"アボカド",                unit:"1/2個(80g)",     g:80,  k:134, cat:"果物"},
  {n:"ブルーベリー",            unit:"1カップ(100g)",   g:100, k:49,  cat:"果物"},
  {n:"なし",                    unit:"中1個(200g)",     g:200, k:84,  cat:"果物"},
  {n:"柿",                      unit:"中1個(150g)",     g:150, k:90,  cat:"果物"},
  // ══ コンビニ ══
  {n:"セブン おにぎり",         unit:"1個(110g)",       g:110, k:190, cat:"コンビニ"},
  {n:"ファミマ サラダチキン",   unit:"1袋(115g)",       g:115, k:130, cat:"コンビニ"},
  {n:"ローソン サラダチキン",   unit:"1袋(110g)",       g:110, k:120, cat:"コンビニ"},
  {n:"セブン サラダチキン",     unit:"1袋(115g)",       g:115, k:125, cat:"コンビニ"},
  {n:"コンビニ 唐揚げ弁当",     unit:"1個(500g)",       g:500, k:780, cat:"コンビニ"},
  {n:"コンビニ 幕の内弁当",     unit:"1個(450g)",       g:450, k:620, cat:"コンビニ"},
  {n:"コンビニ のり弁当",       unit:"1個(400g)",       g:400, k:650, cat:"コンビニ"},
  {n:"コンビニ チキン南蛮弁当", unit:"1個(500g)",       g:500, k:720, cat:"コンビニ"},
  {n:"コンビニ 焼き肉弁当",     unit:"1個(550g)",       g:550, k:820, cat:"コンビニ"},
  {n:"コンビニ パスタサラダ",   unit:"1個(200g)",       g:200, k:280, cat:"コンビニ"},
  {n:"コンビニ ざるそば",       unit:"1個(300g)",       g:300, k:330, cat:"コンビニ"},
  {n:"コンビニ ざるうどん",     unit:"1個(300g)",       g:300, k:295, cat:"コンビニ"},
  {n:"コンビニ 肉まん",         unit:"1個(100g)",       g:100, k:230, cat:"コンビニ"},
  {n:"コンビニ あんまん",       unit:"1個(100g)",       g:100, k:250, cat:"コンビニ"},
  {n:"コンビニ ホットドッグ",   unit:"1個(120g)",       g:120, k:290, cat:"コンビニ"},
  {n:"コンビニ フランクフルト", unit:"1本(70g)",        g:70,  k:197, cat:"コンビニ"},
  {n:"コンビニ プリン",         unit:"1個(100g)",       g:100, k:120, cat:"コンビニ"},
  {n:"コンビニ シュークリーム", unit:"1個(80g)",        g:80,  k:190, cat:"コンビニ"},
  {n:"コンビニ ロールケーキ",   unit:"1個(80g)",        g:80,  k:230, cat:"コンビニ"},
  {n:"コンビニ 牛乳",           unit:"200ml",           g:200, k:134, cat:"コンビニ"},
  {n:"コンビニ カフェラテ",     unit:"200ml",           g:200, k:120, cat:"コンビニ"},
  // ══ ファストフード ══
  {n:"マクドナルド ビッグマック",      unit:"1個(215g)", g:215, k:557, cat:"ファスト"},
  {n:"マクドナルド マックフライポテトM",unit:"1個(135g)",g:135, k:454, cat:"ファスト"},
  {n:"マクドナルド マックフライポテトL",unit:"1個(170g)",g:170, k:571, cat:"ファスト"},
  {n:"マクドナルド ハンバーガー",      unit:"1個(100g)", g:100, k:257, cat:"ファスト"},
  {n:"マクドナルド チキンクリスプ",    unit:"1個(130g)", g:130, k:340, cat:"ファスト"},
  {n:"マクドナルド フィレオフィッシュ",unit:"1個(140g)", g:140, k:380, cat:"ファスト"},
  {n:"マクドナルド てりやきマックバーガー",unit:"1個(170g)",g:170,k:491,cat:"ファスト"},
  {n:"吉野家 牛丼（並）",       unit:"1杯(376g)",       g:376, k:656, cat:"ファスト"},
  {n:"吉野家 牛丼（大盛）",     unit:"1杯(476g)",       g:476, k:836, cat:"ファスト"},
  {n:"吉野家 牛丼（特盛）",     unit:"1杯(576g)",       g:576, k:986, cat:"ファスト"},
  {n:"松屋 牛めし（並）",       unit:"1杯(380g)",       g:380, k:631, cat:"ファスト"},
  {n:"すき家 牛丼（並）",       unit:"1杯(352g)",       g:352, k:633, cat:"ファスト"},
  {n:"すき家 牛丼（大盛）",     unit:"1杯(452g)",       g:452, k:813, cat:"ファスト"},
  {n:"サブウェイ テリヤキチキン",unit:"1個(249g)",      g:249, k:385, cat:"ファスト"},
  {n:"サブウェイ BLT",          unit:"1個(220g)",       g:220, k:320, cat:"ファスト"},
  {n:"ケンタッキー オリジナルチキン",unit:"1ピース(135g)",g:135,k:345,cat:"ファスト"},
  {n:"ケンタッキー チキンフィレサンド",unit:"1個(180g)",g:180, k:490, cat:"ファスト"},
  {n:"モスバーガー モスバーガー",unit:"1個(179g)",      g:179, k:380, cat:"ファスト"},
  {n:"モスバーガー テリヤキバーガー",unit:"1個(191g)",  g:191, k:434, cat:"ファスト"},
  {n:"丸亀製麺 かけうどん（並）",unit:"1杯(330g)",      g:330, k:298, cat:"ファスト"},
  {n:"丸亀製麺 ぶっかけうどん（並）",unit:"1杯(370g)",  g:370, k:380, cat:"ファスト"},
  {n:"餃子の王将 餃子",         unit:"6個(162g)",       g:162, k:309, cat:"ファスト"},
  {n:"餃子の王将 炒飯",         unit:"1皿(350g)",       g:350, k:578, cat:"ファスト"},
  {n:"CoCo壱番屋 カレー（普通）",unit:"1皿(500g)",      g:500, k:730, cat:"ファスト"},
  {n:"CoCo壱番屋 カツカレー",   unit:"1皿(650g)",       g:650, k:1050,cat:"ファスト"},
  // ══ スポーツ補食 ══
  {n:"ホエイプロテイン（水）",   unit:"1杯(30g粉)",      g:30,  k:111, cat:"補食"},
  {n:"ホエイプロテイン（牛乳）", unit:"1杯(250ml)",      g:250, k:245, cat:"補食"},
  {n:"カゼインプロテイン",       unit:"1杯(30g)",        g:30,  k:117, cat:"補食"},
  {n:"ソイプロテイン",           unit:"1杯(30g)",        g:30,  k:105, cat:"補食"},
  {n:"植物性プロテイン",         unit:"1杯(30g)",        g:30,  k:108, cat:"補食"},
  {n:"ガイナックス プロテイン",  unit:"1杯(30g)",        g:30,  k:114, cat:"補食"},
  {n:"DNS プロテイン",           unit:"1杯(30g)",        g:30,  k:112, cat:"補食"},
  {n:"ザバス ホエイプロテイン",  unit:"1杯(28g)",        g:28,  k:105, cat:"補食"},
  {n:"マイプロテイン Impact",    unit:"1杯(25g)",        g:25,  k:100, cat:"補食"},
  {n:"ビーレジェンド プロテイン",unit:"1杯(30g)",        g:30,  k:111, cat:"補食"},
  {n:"BCAA",                     unit:"1杯(10g)",        g:10,  k:40,  cat:"補食"},
  {n:"EAA",                      unit:"1杯(15g)",        g:15,  k:50,  cat:"補食"},
  {n:"クレアチン",               unit:"小さじ1(5g)",     g:5,   k:0,   cat:"補食"},
  {n:"マルトデキストリン",       unit:"大さじ2(20g)",    g:20,  k:78,  cat:"補食"},
  {n:"グルタミン",               unit:"小さじ1(5g)",     g:5,   k:17,  cat:"補食"},
  {n:"HMB",                      unit:"1粒(1g)",         g:1,   k:0,   cat:"補食"},
  {n:"エネルギーゼリー",         unit:"1袋(180g)",       g:180, k:90,  cat:"補食"},
  {n:"エネルギーゼリー（MAG）",  unit:"1袋(180g)",       g:180, k:108, cat:"補食"},
  {n:"スポーツドリンク",         unit:"500ml",           g:500, k:115, cat:"補食"},
  {n:"アクエリアス",             unit:"500ml",           g:500, k:95,  cat:"補食"},
  {n:"ポカリスエット",           unit:"500ml",           g:500, k:125, cat:"補食"},
  {n:"ゲータレード",             unit:"500ml",           g:500, k:130, cat:"補食"},
  {n:"ポカリスエット（1L）",     unit:"1L",              g:1000,k:250, cat:"補食"},
  {n:"inバー プロテイン",        unit:"1本(33g)",        g:33,  k:143, cat:"補食"},
  {n:"inゼリー エネルギー",      unit:"1袋(180g)",       g:180, k:108, cat:"補食"},
  {n:"ザバス ミルクプロテイン",  unit:"1本(200ml)",      g:200, k:130, cat:"補食"},
  {n:"ウイダーinゼリー",         unit:"1袋(180g)",       g:180, k:90,  cat:"補食"},
  {n:"パワープロダクション ゼリー",unit:"1袋(180g)",     g:180, k:100, cat:"補食"},
  {n:"アミノバイタル",           unit:"1本(3g)",         g:3,   k:10,  cat:"補食"},
  {n:"アミノバイタルゼリー",     unit:"1袋(130g)",       g:130, k:65,  cat:"補食"},
  {n:"マグネシウムサプリ",       unit:"1粒(1g)",         g:1,   k:0,   cat:"補食"},
  {n:"鉄分サプリ",               unit:"1粒(1g)",         g:1,   k:0,   cat:"補食"},
  {n:"ビタミンCサプリ",          unit:"1粒(1g)",         g:1,   k:0,   cat:"補食"},
  {n:"マルチビタミン",           unit:"1粒(2g)",         g:2,   k:5,   cat:"補食"},
  {n:"オメガ3（フィッシュオイル）",unit:"1粒(1g)",       g:1,   k:9,   cat:"補食"},
  {n:"コラーゲンサプリ",         unit:"1包(5g)",         g:5,   k:18,  cat:"補食"},
  {n:"プロテインバー（一般）",   unit:"1本(45g)",        g:45,  k:180, cat:"補食"},
  {n:"プロテインバー（DNS）",    unit:"1本(45g)",        g:45,  k:185, cat:"補食"},
  {n:"プロテインバー（ザバス）", unit:"1本(40g)",        g:40,  k:162, cat:"補食"},
  {n:"カーボドリンク",           unit:"500ml",           g:500, k:200, cat:"補食"},
  {n:"ミールリプレイスメント",   unit:"1杯(50g)",        g:50,  k:190, cat:"補食"},
  // ══ 菓子・デザート ══
  {n:"カステラ",                 unit:"1切(50g)",        g:50,  k:159, cat:"菓子"},
  {n:"おせんべい",               unit:"1枚(10g)",        g:10,  k:38,  cat:"菓子"},
  {n:"ポテトチップス",           unit:"1袋(60g)",        g:60,  k:328, cat:"菓子"},
  {n:"チョコレート",             unit:"1枚(50g)",        g:50,  k:270, cat:"菓子"},
  {n:"ミルクチョコレート",       unit:"1枚(50g)",        g:50,  k:278, cat:"菓子"},
  {n:"アイスクリーム",           unit:"1個(120ml)",      g:100, k:212, cat:"菓子"},
  {n:"ソフトクリーム",           unit:"1個(100g)",       g:100, k:146, cat:"菓子"},
  {n:"どら焼き",                 unit:"1個(80g)",        g:80,  k:240, cat:"菓子"},
  {n:"大福",                     unit:"1個(70g)",        g:70,  k:185, cat:"菓子"},
  {n:"ショートケーキ",           unit:"1個(120g)",       g:120, k:357, cat:"菓子"},
  {n:"チーズケーキ",             unit:"1個(100g)",       g:100, k:318, cat:"菓子"},
  {n:"シュークリーム",           unit:"1個(80g)",        g:80,  k:190, cat:"菓子"},
  {n:"プリン",                   unit:"1個(100g)",       g:100, k:116, cat:"菓子"},
  {n:"ゼリー",                   unit:"1個(100g)",       g:100, k:58,  cat:"菓子"},
  {n:"ヨーカン",                 unit:"1切(80g)",        g:80,  k:224, cat:"菓子"},
  {n:"たい焼き",                 unit:"1個(100g)",       g:100, k:280, cat:"菓子"},
  {n:"みたらし団子",             unit:"3個(90g)",        g:90,  k:207, cat:"菓子"},
  {n:"クッキー",                 unit:"3枚(30g)",        g:30,  k:151, cat:"菓子"},
  {n:"ビスケット",               unit:"3枚(30g)",        g:30,  k:143, cat:"菓子"},
  {n:"柿の種",                   unit:"1袋(30g)",        g:30,  k:122, cat:"菓子"},
  {n:"チップスター",             unit:"1箱(50g)",        g:50,  k:268, cat:"菓子"},
  {n:"グミ",                     unit:"1袋(50g)",        g:50,  k:162, cat:"菓子"},
  {n:"キャラメル",               unit:"5個(30g)",        g:30,  k:126, cat:"菓子"},
  {n:"マシュマロ",               unit:"5個(30g)",        g:30,  k:97,  cat:"菓子"},
  // ══ 飲み物 ══
  {n:"オレンジジュース",         unit:"コップ1杯(200ml)",g:200, k:84,  cat:"飲物"},
  {n:"りんごジュース",           unit:"コップ1杯(200ml)",g:200, k:92,  cat:"飲物"},
  {n:"グレープジュース",         unit:"コップ1杯(200ml)",g:200, k:116, cat:"飲物"},
  {n:"野菜ジュース",             unit:"1本(200ml)",      g:200, k:74,  cat:"飲物"},
  {n:"トマトジュース",           unit:"1本(200ml)",      g:200, k:38,  cat:"飲物"},
  {n:"コーラ",                   unit:"500ml",           g:500, k:215, cat:"飲物"},
  {n:"コーラ（ゼロ）",           unit:"500ml",           g:500, k:0,   cat:"飲物"},
  {n:"サイダー",                 unit:"500ml",           g:500, k:195, cat:"飲物"},
  {n:"コーヒー（ブラック）",     unit:"1杯(150ml)",      g:150, k:6,   cat:"飲物"},
  {n:"カフェラテ",               unit:"1杯(200ml)",      g:200, k:120, cat:"飲物"},
  {n:"カフェオレ",               unit:"1杯(200ml)",      g:200, k:110, cat:"飲物"},
  {n:"カプチーノ",               unit:"1杯(180ml)",      g:180, k:90,  cat:"飲物"},
  {n:"緑茶",                     unit:"1杯(150ml)",      g:150, k:3,   cat:"飲物"},
  {n:"麦茶",                     unit:"1杯(150ml)",      g:150, k:0,   cat:"飲物"},
  {n:"ほうじ茶",                 unit:"1杯(150ml)",      g:150, k:0,   cat:"飲物"},
  {n:"牛乳（200ml）",            unit:"1本(200ml)",      g:200, k:134, cat:"飲物"},
  {n:"豆乳（200ml）",            unit:"1本(200ml)",      g:200, k:88,  cat:"飲物"},
  {n:"甘酒",                     unit:"1杯(200ml)",      g:200, k:130, cat:"飲物"},
  {n:"炭酸水",                   unit:"500ml",           g:500, k:0,   cat:"飲物"},
  {n:"エナジードリンク",         unit:"1缶(250ml)",      g:250, k:113, cat:"飲物"},
  {n:"モンスターエナジー",       unit:"1缶(355ml)",      g:355, k:160, cat:"飲物"},
  {n:"レッドブル",               unit:"1缶(250ml)",      g:250, k:113, cat:"飲物"},
];

// カロリーDB検索関数（あいまい検索）
function searchFoodDB(query) {
  if (!query.trim()) return [];
  const q = query.toLowerCase().trim();
  return FOOD_DB.filter(f =>
    f.n.includes(q) || f.cat.includes(q) ||
    (q.length >= 2 && f.n.toLowerCase().includes(q.slice(0,2)))
  ).slice(0, 8);
}

// テキストからDB参照でカロリーを推定
function estimateFromDB(text) {
  // 区切り文字で分割（正規表現内に全角文字を入れないためreplace+splitで処理）
  // 全角文字は正規表現外でreplaceAll処理
  const normalized = text.replaceAll("、", ",").replaceAll("，", ",").replaceAll("　", ",").replace(/\s+/g, ",");
  const lines = normalized.split(",").map(s => s.trim()).filter(Boolean);
  const items = [];
  let total = 0;
  for (const line of lines) {
    // 数量を抽出 (例: "唐揚げ3個")
    // 数字を含む場合に分解（例: "唐揚げ3" → name="唐揚げ", count=3）
    const numMatch = line.match(/^(.+?)([0-9]+(?:\.[0-9]+)?)([a-zA-Z]*)$/);
    const name = numMatch ? numMatch[1] : line;
    const count = numMatch ? parseFloat(numMatch[2]) : 1;
    const unitStr = numMatch ? (numMatch[3] || "") : "";
    // DB検索
    const found = FOOD_DB.find(f => f.n.includes(name) || name.includes(f.n.slice(0, 3)));
    if (found) {
      // g/kcal単位の場合は直接計算
      let kcal;
      if (unitStr === "g") {
        kcal = Math.round(found.k * count / 100);
      } else if (unitStr === "kcal") {
        kcal = count;
      } else {
        // 目安量×個数
        kcal = Math.round(found.k * count);
      }
      items.push({ name: found.n, kcal });
      total += kcal;
    } else {
      // DB未登録はそのまま追加（kcal不明）
      items.push({ name: line, kcal: 0, unknown: true });
    }
  }
  return { items, total, unknowns: items.filter(i => i.unknown).map(i => i.name) };
}

// --- API helpers -------------------------------------------------
function parseJsonSafe(raw) {
  if (!raw) throw new Error("Empty response");
  // Remove code fences using string ops (avoids backtick issues in regex)
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.slice(s.indexOf("\n") + 1);
  }
  if (s.endsWith("```")) {
    s = s.slice(0, s.lastIndexOf("\n"));
  }
  s = s.trim();
  // Extract first JSON object or array
  const start = s.search(/[{[]/);
  if (start === -1) throw new Error("No JSON found in: " + raw.slice(0, 80));
  // find matching end by scanning
  const opener = s[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0, end = -1;
  for (let i = start; i < s.length; i++) {
    if (s[i] === opener) depth++;
    else if (s[i] === closer) { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error("Unmatched JSON bracket");
  return JSON.parse(s.slice(start, end + 1));
}

async function callClaude(userMsg) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: "You are a food calorie estimation expert. Always respond with JSON only. No explanation, no markdown, no code blocks. Just raw JSON.",
      messages: [{ role: "user", content: userMsg }]
    })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.type === "error") throw new Error(data.error?.message || "API error");
  const text = data.content?.map(b => b.text || "").join("") || "";
  return parseJsonSafe(text);
}

async function callClaudeImage(base64, mediaType) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: "You are a food calorie estimation expert. Always respond with JSON only. No explanation, no markdown, no code blocks.",
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        { type: "text", text: 'Analyze this meal image. Respond ONLY with JSON: {"items":[{"name":"food name","kcal":number}],"total":number,"description":"brief description"}' }
      ]}]
    })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.type === "error") throw new Error(data.error?.message || "API error");
  const text = data.content?.map(b => b.text || "").join("") || "";
  return parseJsonSafe(text);
}

// --- SVG Line Chart component ------------------------------------
function LineChart({ data, color="#1c3a1c", dotColor="#c0392b", height=90, unit="", targetLine=null, targetColor="rgba(46,204,113,.35)" }) {
  if (!data || data.length < 2) {
    return <div style={{textAlign:"center",padding:"20px 0",color:"#ccc",fontSize:13}}>データが2件以上になるとグラフが表示されます</div>;
  }
  const vals = data.map(d => d.v);
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const pad_v = (mx - mn) * 0.15 || 1;
  const lo = mn - pad_v, hi = mx + pad_v, rng = hi - lo;
  const W = 100, H = height;
  const xOf = i => (i / (data.length - 1)) * W;
  const yOf = v => H - 8 - ((v - lo) / rng) * (H - 16);
  const pts = data.map((d,i) => `${xOf(i)},${yOf(d.v)}`).join(" ");
  const fillPts = `0,${H} ${pts} ${W},${H}`;

  return (
    <div style={{position:"relative"}}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{width:"100%",height:height,display:"block"}}>
        {/* target line */}
        {targetLine != null && <line x1="0" y1={yOf(targetLine)} x2={W} y2={yOf(targetLine)} stroke={targetColor} strokeWidth="1.2" vectorEffect="non-scaling-stroke" strokeDasharray="4,3"/>}
        {/* fill */}
        <polygon points={fillPts} fill={color} opacity="0.07"/>
        {/* line */}
        <polyline points={pts} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round"/>
        {/* dots */}
        {data.map((d,i) => (
          <circle key={i} cx={xOf(i)} cy={yOf(d.v)} r="3" fill={dotColor} vectorEffect="non-scaling-stroke"/>
        ))}
      </svg>
      {/* x-axis labels */}
      <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
        {data.length <= 10
          ? data.map((d,i) => <span key={i} style={{fontSize:9,color:"#aaa",flex:1,textAlign:"center"}}>{d.label}</span>)
          : [data[0], data[Math.floor(data.length/2)], data[data.length-1]].map((d,i) => (
              <span key={i} style={{fontSize:9,color:"#aaa"}}>{d.label}</span>
            ))
        }
      </div>
      {/* min/max labels */}
      <div style={{display:"flex",justifyContent:"space-between",position:"absolute",top:0,right:0,flexDirection:"column",height:height,pointerEvents:"none"}}>
        <span style={{fontSize:9,color:"#aaa",background:"rgba(255,255,255,.8)",padding:"1px 4px",borderRadius:4}}>{mx.toFixed(1)}{unit}</span>
        <span style={{fontSize:9,color:"#aaa",background:"rgba(255,255,255,.8)",padding:"1px 4px",borderRadius:4}}>{mn.toFixed(1)}{unit}</span>
      </div>
    </div>
  );
}



// ════════════════════════════════════════════════════════════════
// FOOD SEARCH BOX — 食品検索＋追加UI（食事用）
// ════════════════════════════════════════════════════════════════
function FoodSearchBox({ addedItems, onAdd, onRemove }) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [catFilter, setCatFilter] = useState("全て");

  const CATS = ["全て","主食","肉","魚","副菜","乳製品","果物","補食","コンビニ","ファスト","菓子","飲物"];

  useEffect(() => {
    if (query.trim().length === 0) {
      // カテゴリフィルタ時は全表示（最大12件）
      if (catFilter !== "全て") {
        setSuggestions(FOOD_DB.filter(f => f.cat === catFilter).slice(0, 12));
      } else {
        setSuggestions([]);
      }
    } else {
      const results = searchFoodDB(query).filter(f => catFilter === "全て" || f.cat === catFilter);
      setSuggestions(results);
    }
  }, [query, catFilter]);

  return (
    <div style={{marginBottom:10}}>
      <div style={{fontSize:11,fontWeight:700,color:"#1c3a1c",letterSpacing:1,marginBottom:8}}>
        🔍 食品を検索して追加
        <span style={{fontSize:10,fontWeight:400,color:"#8b7355",marginLeft:8}}>文部科学省成分表DB</span>
      </div>

      {/* カテゴリフィルタ */}
      <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:8}}>
        {["全て","主食","肉","魚","副菜","乳製品","果物","補食","コンビニ","ファスト","菓子","飲物"].map(cat=>(
          <button key={cat} onClick={()=>setCatFilter(cat)}
            style={{padding:"4px 10px",borderRadius:16,border:`1.5px solid ${catFilter===cat?"#1c3a1c":"#ddd"}`,
              background:catFilter===cat?"#1c3a1c":"#fff",color:catFilter===cat?"#f0e68c":"#666",
              fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'Noto Sans JP',sans-serif"}}>
            {cat}
          </button>
        ))}
      </div>

      {/* 検索入力 */}
      <div style={{position:"relative",marginBottom:8}}>
        <input className="ti"
          placeholder="食品名を入力（例：鶏むね、プロテイン）"
          value={query}
          onChange={e=>setQuery(e.target.value)}
          style={{fontSize:13,padding:"8px 36px 8px 10px",background:"#fff",borderColor:"#b8d8b8"}}
        />
        {query && (
          <button onClick={()=>setQuery("")}
            style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",color:"#aaa",fontSize:16,padding:0}}>
            ×
          </button>
        )}
      </div>

      {/* サジェスト候補 */}
      {suggestions.length > 0 && (
        <div style={{background:"#f9f5ed",borderRadius:8,border:"1px solid #e0d5c0",marginBottom:8,maxHeight:200,overflowY:"auto"}}>
          {suggestions.map((food, i) => (
            <button key={i} onClick={()=>{ onAdd(food); setQuery(""); setSuggestions([]); }}
              style={{width:"100%",padding:"8px 12px",background:"none",border:"none",borderBottom:"1px solid #f0ebe0",
                cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",
                fontFamily:"'Noto Sans JP',sans-serif",textAlign:"left"}}>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:"#2c1810"}}>{food.n}</div>
                <div style={{fontSize:10,color:"#8b7355"}}>{food.unit} • {food.cat}</div>
              </div>
              <div style={{fontFamily:"Anton,sans-serif",fontSize:16,color:"#c0392b",flexShrink:0,marginLeft:8}}>
                {food.k}<span style={{fontSize:10,fontWeight:400}}>kcal</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* 追加済みアイテム */}
      {addedItems.length > 0 && (
        <div style={{background:"#f0f7f0",borderRadius:8,padding:"8px 10px",border:"1px solid #b8d8b8"}}>
          <div style={{fontSize:10,fontWeight:700,color:"#1c3a1c",marginBottom:6}}>追加済み</div>
          {addedItems.map((item, i) => (
            <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"3px 0",borderBottom:"1px solid rgba(0,0,0,.05)"}}>
              <span style={{fontSize:12,color:"#2c1810"}}>{item.name}</span>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontFamily:"Anton,sans-serif",fontSize:14,color:"#1c3a1c"}}>{item.kcal}<span style={{fontSize:9,fontWeight:400}}>kcal</span></span>
                <button onClick={()=>onRemove(i)}
                  style={{background:"none",border:"none",cursor:"pointer",color:"#e74c3c",fontSize:14,padding:0,lineHeight:1}}>×</button>
              </div>
            </div>
          ))}
          <div style={{display:"flex",justifyContent:"flex-end",marginTop:6,paddingTop:4,borderTop:"1px solid #b8d8b8"}}>
            <span style={{fontSize:11,color:"#1c3a1c",fontWeight:700}}>
              合計: <span style={{fontFamily:"Anton,sans-serif",fontSize:18,color:"#c0392b"}}>{addedItems.reduce((s,i)=>s+i.kcal,0)}</span>kcal
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// SNACK SEARCH BOX — 捕食・サプリ用（シンプル版）
// ════════════════════════════════════════════════════════════════
function SnackSearchBox({ value, kcal, onSelect, onKcalChange, onNameChange }) {
  const [query, setQuery] = useState(value || "");
  const [suggestions, setSuggestions] = useState([]);
  const [focused, setFocused] = useState(false);

  useEffect(() => { setQuery(value || ""); }, [value]);

  useEffect(() => {
    if (query.trim().length >= 1 && focused) {
      setSuggestions(searchFoodDB(query).slice(0, 6));
    } else {
      setSuggestions([]);
    }
  }, [query, focused]);

  return (
    <div style={{position:"relative",marginBottom:8}}>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        <div style={{flex:2,position:"relative"}}>
          <input className="ti"
            placeholder="食品名を検索"
            style={{fontSize:13,padding:"8px 10px",width:"100%"}}
            value={query}
            onChange={e=>{ setQuery(e.target.value); onNameChange(e.target.value); }}
            onFocus={()=>setFocused(true)}
            onBlur={()=>setTimeout(()=>setFocused(false),150)}
          />
          {focused && suggestions.length > 0 && (
            <div style={{position:"absolute",top:"100%",left:0,right:0,background:"#fff",border:"1px solid #e0d5c0",borderRadius:8,zIndex:50,boxShadow:"0 4px 12px rgba(0,0,0,.15)",maxHeight:160,overflowY:"auto"}}>
              {suggestions.map((food,i)=>(
                <button key={i}
                  onMouseDown={()=>{ onSelect(food); setQuery(food.n); setSuggestions([]); }}
                  style={{width:"100%",padding:"7px 10px",background:"none",border:"none",borderBottom:"1px solid #f5f0e8",
                    cursor:"pointer",display:"flex",justifyContent:"space-between",fontFamily:"'Noto Sans JP',sans-serif",textAlign:"left"}}>
                  <div>
                    <div style={{fontSize:12,fontWeight:700,color:"#2c1810"}}>{food.n}</div>
                    <div style={{fontSize:10,color:"#8b7355"}}>{food.unit}</div>
                  </div>
                  <span style={{fontFamily:"Anton,sans-serif",fontSize:14,color:"#c0392b",flexShrink:0}}>{food.k}kcal</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <input className="ni" type="number" placeholder="kcal"
          style={{flex:1,fontSize:15,padding:"8px 10px"}}
          value={kcal} onChange={e=>onKcalChange(e.target.value)}
        />
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// PAIN BODY MAP CARD
// ════════════════════════════════════════════════════════════════
function PainCard({ pain, onChange }) {
  const [bodyView, setBodyView] = useState("front"); // front | back
  const [selected, setSelected] = useState(null); // part id being edited

  const getPain = (id) => pain.find(p => p.id === id);
  const hasPain = (id) => !!getPain(id);

  const togglePart = (part) => {
    if (hasPain(part.id)) {
      // if already has pain, open editor
      setSelected(selected === part.id ? null : part.id);
    } else {
      // add with default level 0
      onChange([...pain, { id: part.id, label: part.label, level: 0, note: "" }]);
      setSelected(part.id);
    }
  };

  const updatePain = (id, key, val) => {
    onChange(pain.map(p => p.id === id ? { ...p, [key]: val } : p));
  };

  const removePain = (id) => {
    onChange(pain.filter(p => p.id !== id));
    setSelected(null);
  };

  const visibleParts = BODY_PARTS.filter(p => p.side === bodyView);
  const selectedEntry = selected ? getPain(selected) : null;
  const selectedPart  = selected ? BODY_PARTS.find(p => p.id === selected) : null;

  return (
    <div className="card" style={{"--card-color":"#e74c3c"}}>
      <style>{`.card[style*="--card-color"]::before{background:var(--card-color)!important;}`}</style>
      <div className="stitle" style={{color:"#e74c3c"}}>
        🩹 痛み・違和感のある部位
        {pain.length > 0 && (
          <span style={{background:"#e74c3c",color:"#fff",borderRadius:20,padding:"1px 8px",fontSize:11,marginLeft:6}}>
            {pain.length}箇所
          </span>
        )}
      </div>

      {/* front / back toggle */}
      <div style={{display:"flex",background:"#f0ebe0",borderRadius:8,padding:3,marginBottom:12,gap:3}}>
        {[["front","前面"],["back","背面"]].map(([v,l])=>(
          <button key={v} onClick={()=>{ setBodyView(v); setSelected(null); }}
            style={{flex:1,padding:"7px 0",border:"none",borderRadius:6,cursor:"pointer",fontFamily:"'Noto Sans JP',sans-serif",fontSize:13,fontWeight:700,transition:"all .2s",
              background:bodyView===v?"#1c3a1c":"transparent",color:bodyView===v?"#f0e68c":"#8b7355"}}>
            {l}
          </button>
        ))}
      </div>

      {/* body silhouette + dots */}
      <div style={{position:"relative",width:"100%",maxWidth:220,margin:"0 auto",userSelect:"none"}}>
        {/* SVG silhouette */}
        <svg viewBox="0 0 100 100" style={{width:"100%",display:"block",opacity:.13}}>
          {bodyView==="front" ? (
            <>
              {/* head */}
              <ellipse cx="50" cy="7" rx="8" ry="9" fill="#2c1810"/>
              {/* neck */}
              <rect x="46" y="15" width="8" height="5" rx="2" fill="#2c1810"/>
              {/* torso */}
              <path d="M34 20 Q50 18 66 20 L70 48 Q50 52 30 48 Z" fill="#2c1810"/>
              {/* l arm */}
              <path d="M34 21 Q25 28 22 38 Q21 42 23 44" stroke="#2c1810" strokeWidth="6" fill="none" strokeLinecap="round"/>
              {/* r arm */}
              <path d="M66 21 Q75 28 78 38 Q79 42 77 44" stroke="#2c1810" strokeWidth="6" fill="none" strokeLinecap="round"/>
              {/* l leg */}
              <path d="M41 48 Q39 62 38 72 Q37 80 38 88" stroke="#2c1810" strokeWidth="7" fill="none" strokeLinecap="round"/>
              {/* r leg */}
              <path d="M59 48 Q61 62 62 72 Q63 80 62 88" stroke="#2c1810" strokeWidth="7" fill="none" strokeLinecap="round"/>
            </>
          ) : (
            <>
              <ellipse cx="50" cy="7" rx="8" ry="9" fill="#2c1810"/>
              <rect x="46" y="15" width="8" height="5" rx="2" fill="#2c1810"/>
              <path d="M34 20 Q50 18 66 20 L70 48 Q50 52 30 48 Z" fill="#2c1810"/>
              <path d="M34 21 Q25 28 22 38 Q21 42 23 44" stroke="#2c1810" strokeWidth="6" fill="none" strokeLinecap="round"/>
              <path d="M66 21 Q75 28 78 38 Q79 42 77 44" stroke="#2c1810" strokeWidth="6" fill="none" strokeLinecap="round"/>
              <path d="M41 48 Q39 62 38 72 Q37 80 38 88" stroke="#2c1810" strokeWidth="7" fill="none" strokeLinecap="round"/>
              <path d="M59 48 Q61 62 62 72 Q63 80 62 88" stroke="#2c1810" strokeWidth="7" fill="none" strokeLinecap="round"/>
            </>
          )}
        </svg>

        {/* hit dots */}
        {visibleParts.map(part => {
          const entry = getPain(part.id);
          const isSelected = selected === part.id;
          return (
            <button key={part.id}
              onClick={() => togglePart(part)}
              title={part.label}
              style={{
                position:"absolute",
                left:`${part.x}%`, top:`${part.y}%`,
                transform:"translate(-50%,-50%)",
                width: entry ? 18 : 14,
                height: entry ? 18 : 14,
                borderRadius:"50%",
                border: isSelected ? "3px solid #fff" : entry ? "2px solid rgba(255,255,255,.7)" : "2px solid rgba(44,24,16,.25)",
                background: entry ? PAIN_COLORS[entry.level] : "rgba(255,255,255,.55)",
                cursor:"pointer",
                transition:"all .15s",
                boxShadow: isSelected ? "0 0 0 3px "+PAIN_COLORS[entry?.level||0] : entry ? "0 2px 6px rgba(0,0,0,.25)" : "none",
                zIndex: entry ? 2 : 1,
                padding:0,
              }}
            />
          );
        })}
      </div>

      <div style={{fontSize:10,color:"#aaa",textAlign:"center",marginTop:6,marginBottom:8}}>
        タップして痛みのある部位をマーク
      </div>

      {/* selected part editor */}
      {selected && selectedPart && (
        <div style={{marginTop:14,background:"#fff5f5",border:"2px solid #f5b8b8",borderRadius:10,padding:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div style={{fontWeight:900,fontSize:15,color:"#c0392b"}}>📍 {selectedPart.label}</div>
            <button onClick={()=>removePain(selected)}
              style={{background:"#fde8e8",border:"1px solid #f5b8b8",borderRadius:6,padding:"4px 10px",color:"#e74c3c",fontSize:12,fontWeight:700,cursor:"pointer"}}>
              削除
            </button>
          </div>

          {/* pain level */}
          <div style={{fontSize:11,fontWeight:700,color:"#8b7355",letterSpacing:1,marginBottom:8}}>痛みの強さ</div>
          <div style={{display:"flex",gap:6,marginBottom:12}}>
            {PAIN_LEVELS.map((lbl,i) => (
              <button key={i} onClick={()=>updatePain(selected,"level",i)}
                style={{flex:1,padding:"6px 4px",borderRadius:8,border:`2px solid ${PAIN_COLORS[i]}`,
                  background:(selectedEntry?.level??0)===i ? PAIN_COLORS[i] : "transparent",
                  color:(selectedEntry?.level??0)===i ? "#fff" : PAIN_COLORS[i],
                  fontFamily:"'Noto Sans JP',sans-serif",fontSize:11,fontWeight:700,cursor:"pointer",transition:"all .15s"}}>
                {lbl}
              </button>
            ))}
          </div>

          {/* note */}
          <div style={{fontSize:11,fontWeight:700,color:"#8b7355",letterSpacing:1,marginBottom:6}}>メモ（いつから・状況など）</div>
          <textarea className="ti"
            placeholder="例: 昨日から、投球後に痛む"
            style={{fontSize:13,minHeight:56,resize:"vertical",background:"#fff",borderColor:"#f5b8b8"}}
            value={selectedEntry?.note||""}
            onChange={e=>updatePain(selected,"note",e.target.value)}
          />
        </div>
      )}

      {/* summary chips */}
      {pain.length > 0 && !selected && (
        <div style={{marginTop:12,display:"flex",flexWrap:"wrap",gap:6}}>
          {pain.map(p => (
            <div key={p.id}
              onClick={()=>setSelected(p.id)}
              style={{display:"flex",alignItems:"center",gap:5,background:PAIN_COLORS[p.level]+"22",border:`1.5px solid ${PAIN_COLORS[p.level]}`,borderRadius:20,padding:"4px 10px",cursor:"pointer"}}>
              <div style={{width:8,height:8,borderRadius:"50%",background:PAIN_COLORS[p.level],flexShrink:0}}/>
              <span style={{fontSize:12,fontWeight:700,color:PAIN_COLORS[p.level]}}>{p.label}</span>
              <span style={{fontSize:10,color:"#aaa",marginLeft:2}}>{PAIN_LEVELS[p.level]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
export default function App() {
  const [screen, setScreen] = useState("top");
  const [currentAthlete, setCurrentAthlete] = useState(null);
  const [detailAthlete, setDetailAthlete]   = useState(null);

  if (screen==="top")
    return <TopScreen onPlayer={()=>setScreen("player_select")} onCoach={()=>setScreen("coach")} />;
  if (screen==="player_select")
    return <PlayerSelect onSelect={a=>{ setCurrentAthlete(a); setScreen("player"); }} onBack={()=>setScreen("top")} />;
  if (screen==="player")
    return <PlayerView athlete={currentAthlete} onBack={()=>setScreen("top")} />;
  if (screen==="coach")
    return <CoachView onBack={()=>setScreen("top")} onDetail={a=>{ setDetailAthlete(a); setScreen("athlete_detail"); }} />;
  if (screen==="athlete_detail")
    return <AthleteDetail athlete={detailAthlete} onBack={()=>setScreen("coach")} />;
  return null;
}

// ════════════════════════════════════════════════════════════════
// GLOBAL STYLES
// ════════════════════════════════════════════════════════════════
const G = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&family=Anton&display=swap');
    *{box-sizing:border-box;margin:0;padding:0;} input,textarea,select{outline:none;}
    .stripe{background:repeating-linear-gradient(90deg,#c0392b 0,#c0392b 8px,#e8d5a0 8px,#e8d5a0 16px);}
    .hdr-green{background:#1c3a1c;background-image:repeating-linear-gradient(45deg,transparent,transparent 10px,rgba(255,255,255,.02) 10px,rgba(255,255,255,.02) 20px);padding:16px 16px 14px;position:relative;overflow:hidden;}
    .hdr-green::after{content:'';position:absolute;bottom:0;left:0;right:0;height:6px;background:repeating-linear-gradient(90deg,#c0392b 0,#c0392b 8px,#e8d5a0 8px,#e8d5a0 16px);}
    .hdr-navy{background:#1a2340;padding:18px 16px 14px;position:relative;}
    .hdr-navy::after{content:'';position:absolute;bottom:0;left:0;right:0;height:5px;background:repeating-linear-gradient(90deg,#c0392b 0,#c0392b 8px,#e8d5a0 8px,#e8d5a0 16px);}
    .card{background:#fff;border-radius:10px;padding:16px;margin-bottom:14px;box-shadow:0 2px 8px rgba(0,0,0,.08);border:1px solid #e8e0d0;position:relative;}
    .card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:10px 10px 0 0;background:#1c3a1c;}
    .card.red::before{background:#c0392b;} .card.gold::before{background:#d4a017;} .card.blue::before{background:#2471a3;} .card.navy::before{background:#1a2340;}
    .stitle{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#1c3a1c;margin-bottom:12px;display:flex;align-items:center;gap:6px;}
    .ni{background:#f9f5ed;border:2px solid #d4c9b0;border-radius:8px;padding:10px 14px;color:#2c1810;font-size:22px;font-weight:900;font-family:'Anton','Noto Sans JP',sans-serif;width:100%;transition:border-color .2s;}
    .ni:focus{border-color:#1c3a1c;background:#f0f7f0;}
    .ti{background:#f9f5ed;border:2px solid #d4c9b0;border-radius:8px;padding:10px 14px;color:#2c1810;font-size:14px;font-family:'Noto Sans JP',sans-serif;width:100%;transition:border-color .2s;}
    .ti:focus{border-color:#1c3a1c;background:#f0f7f0;}
    .si{background:#f9f5ed;border:2px solid #d4c9b0;border-radius:8px;padding:10px 14px;color:#2c1810;font-size:14px;font-family:'Noto Sans JP',sans-serif;width:100%;}
    .tabbr{display:flex;background:#1c3a1c;border-bottom:3px solid #c0392b;}
    .tabbtn{flex:1;padding:13px 4px;background:none;border:none;cursor:pointer;font-family:'Noto Sans JP',sans-serif;font-size:11px;font-weight:700;color:rgba(255,255,255,.5);transition:all .2s;border-bottom:3px solid transparent;margin-bottom:-3px;}
    .tabbtn.on{color:#f0e68c;border-bottom-color:#f0e68c;}
    .ctabbr{display:flex;background:#1a2340;border-bottom:3px solid #c0392b;}
    .ctabbtn{flex:1;padding:12px 4px;background:none;border:none;cursor:pointer;font-family:'Noto Sans JP',sans-serif;font-size:11px;font-weight:700;color:rgba(255,255,255,.4);transition:all .2s;border-bottom:3px solid transparent;margin-bottom:-3px;}
    .ctabbtn.on{color:#ffd700;border-bottom-color:#ffd700;}
    .savebtn{width:100%;padding:16px;background:#1c3a1c;border:3px solid #c0392b;border-radius:10px;color:#f0e68c;font-family:'Anton','Noto Sans JP',sans-serif;font-size:18px;font-weight:700;letter-spacing:3px;cursor:pointer;transition:all .15s;}
    .savebtn:active{transform:scale(.97);}
    .fbtn{flex:1;padding:8px 4px;border-radius:8px;border:2px solid transparent;background:#f9f5ed;cursor:pointer;font-size:10px;font-weight:700;font-family:'Noto Sans JP',sans-serif;transition:all .2s;line-height:1.3;text-align:center;color:#888;}
    .msec{background:#f9f5ed;border:2px solid #e0d5c0;border-radius:10px;margin-bottom:10px;overflow:hidden;}
    .mhdr{padding:10px 14px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;user-select:none;}
    .mbdy{padding:0 14px 14px;border-top:1px solid #e0d5c0;}
    .pbtn{width:100%;padding:10px;border:2px dashed #c0b090;border-radius:8px;background:transparent;color:#8b7355;font-family:'Noto Sans JP',sans-serif;font-size:12px;font-weight:700;cursor:pointer;transition:all .2s;margin-top:10px;display:flex;align-items:center;justify-content:center;gap:6px;}
    .schip{padding:6px 14px;border-radius:20px;border:2px solid #c0392b;background:transparent;color:#c0392b;font-size:12px;font-weight:700;font-family:'Noto Sans JP',sans-serif;cursor:pointer;transition:all .2s;white-space:nowrap;}
    .schip:hover{background:#c0392b;color:white;}
    .kbadge{background:#c0392b;color:white;font-family:'Anton',sans-serif;font-size:13px;letter-spacing:1px;padding:3px 10px;border-radius:20px;}
    .totbar{background:linear-gradient(135deg,#1c3a1c,#2e5c2e);border-radius:10px;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;border:2px solid #c0392b;}
    .hcard{background:#fff;border-radius:10px;padding:14px 16px;margin-bottom:10px;box-shadow:0 2px 6px rgba(0,0,0,.07);border-left:4px solid #1c3a1c;cursor:pointer;}
    .sbox{background:#fff;border-radius:10px;padding:14px;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.07);}
    .estbox{background:#f0f7f0;border:2px solid #b8d8b8;border-radius:10px;padding:12px;margin-top:12px;margin-bottom:8px;}
    .estbtn{padding:9px 16px;border-radius:8px;border:none;font-weight:700;font-size:13px;cursor:pointer;font-family:'Noto Sans JP',sans-serif;white-space:nowrap;transition:all .15s;}
    .athlete-row{display:flex;align-items:center;gap:12px;padding:14px 16px;background:#fff;border-radius:10px;margin-bottom:10px;box-shadow:0 2px 6px rgba(0,0,0,.07);cursor:pointer;transition:all .15s;border-left:4px solid #1c3a1c;}
    .athlete-row:hover{transform:translateX(3px);box-shadow:0 4px 12px rgba(0,0,0,.12);}
    .toast{position:fixed;bottom:88px;left:50%;transform:translateX(-50%);background:#1c3a1c;border:2px solid #f0e68c;color:#f0e68c;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:700;z-index:200;white-space:nowrap;animation:popIn .25s ease;box-shadow:0 4px 20px rgba(0,0,0,.3);font-family:'Noto Sans JP',sans-serif;}
    @keyframes popIn{from{opacity:0;transform:translateX(-50%) scale(.9);}to{opacity:1;transform:translateX(-50%) scale(1);}}
    @keyframes spin{from{transform:rotate(0);}to{transform:rotate(360deg);}}
    .spin{animation:spin 1s linear infinite;display:inline-block;}
    .modebtn{padding:20px 24px;border-radius:12px;font-family:'Noto Sans JP',sans-serif;font-size:18px;font-weight:900;cursor:pointer;display:flex;align-items:center;gap:16px;transition:all .2s;width:100%;}
    .modebtn:hover{transform:translateY(-2px);}
    .overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;display:flex;align-items:center;justify-content:center;padding:20px;}
    .modal{background:#fff;border-radius:14px;padding:24px;width:100%;max-width:400px;box-shadow:0 8px 40px rgba(0,0,0,.3);}
  `}</style>
);

// ════════════════════════════════════════════════════════════════
// TOP SCREEN
// ════════════════════════════════════════════════════════════════
function TopScreen({ onPlayer, onCoach }) {
  return (
    <div style={{minHeight:"100vh",background:"#1c3a1c",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,fontFamily:"'Noto Sans JP',sans-serif",position:"relative",overflow:"hidden"}}>
      <G/>
      <div style={{position:"fixed",top:0,left:0,right:0,height:8}} className="stripe"/>
      <div style={{position:"fixed",bottom:0,left:0,right:0,height:8}} className="stripe"/>
      <div style={{position:"absolute",inset:0,backgroundImage:"repeating-linear-gradient(45deg,rgba(255,255,255,.015) 0,rgba(255,255,255,.015) 1px,transparent 1px,transparent 20px)",pointerEvents:"none"}}/>
      <div style={{fontSize:80,marginBottom:8,filter:"drop-shadow(0 4px 12px rgba(0,0,0,.4))"}}>⚾</div>
      <div style={{fontFamily:"Anton,sans-serif",fontSize:34,color:"#f0e68c",letterSpacing:4,marginBottom:4}}>BASEBALL</div>
      <div style={{fontFamily:"Anton,sans-serif",fontSize:22,color:"rgba(255,255,255,.8)",letterSpacing:2,marginBottom:48}}>HEALTH TRACKER</div>
      <div style={{display:"flex",flexDirection:"column",gap:14,width:"100%",maxWidth:340}}>
        <button className="modebtn" onClick={onPlayer} style={{border:"3px solid #f0e68c",background:"rgba(240,230,140,.1)",color:"#f0e68c"}}>
          <span style={{fontSize:38}}>🏃</span>
          <div style={{textAlign:"left"}}><div>選手モード</div><div style={{fontSize:12,fontWeight:400,opacity:.7,marginTop:2}}>自分の体調を毎日記録する</div></div>
        </button>
        <button className="modebtn" onClick={onCoach} style={{border:"3px solid #e88080",background:"rgba(192,57,43,.15)",color:"#e88080"}}>
          <span style={{fontSize:38}}>📋</span>
          <div style={{textAlign:"left"}}><div>指導者モード</div><div style={{fontSize:12,fontWeight:400,opacity:.7,marginTop:2}}>全選手の状態を管理・確認する</div></div>
        </button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// PLAYER SELECT (with register)
// ════════════════════════════════════════════════════════════════
function PlayerSelect({ onSelect, onBack }) {
  const today = todayKey();
  const [roster, setRoster] = useState(getRoster);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name:"", position:"投手", height:"", goal:"bulk" });
  const [err, setErr] = useState("");

  const register = () => {
    if (!form.name.trim()) { setErr("名前を入力してください"); return; }
    if (roster.find(a => a.name === form.name.trim())) { setErr("同じ名前の選手がすでに登録されています"); return; }
    const newAthlete = { id: genId(), name: form.name.trim(), position: form.position, height: form.height.trim(), goal: form.goal || "bulk" };
    const next = [...roster, newAthlete];
    saveRoster(next);
    setRoster(next);
    syncRosterToSupabase(newAthlete); // Supabaseに同期
    setShowForm(false);
    setForm({ name:"", position:"投手", height:"", goal:"bulk" });
    setErr("");
    onSelect(newAthlete);
  };

  // Supabaseから選手リストを取得してローカルにマージ
  useEffect(() => {
    fetchRosterFromSupabase().then(sbRoster => {
      if (sbRoster.length > 0) {
        const local = getRoster();
        const merged = [...sbRoster];
        local.forEach(a => { if (!merged.find(s => s.id === a.id)) merged.push(a); });
        saveRoster(merged);
        setRoster(merged);
      }
    });
  }, []);

  return (
    <div style={{minHeight:"100vh",background:"#1c3a1c",fontFamily:"'Noto Sans JP',sans-serif"}}>
      <G/>
      <div style={{background:"rgba(0,0,0,.3)",padding:"20px 16px 16px",position:"relative"}}>
        <div style={{position:"absolute",bottom:0,left:0,right:0,height:5}} className="stripe"/>
        <button onClick={onBack} style={{background:"none",border:"none",color:"rgba(255,255,255,.5)",cursor:"pointer",fontSize:13,fontWeight:700,marginBottom:8,padding:0}}>← 戻る</button>
        <div style={{fontFamily:"Anton,sans-serif",fontSize:24,color:"#f0e68c",letterSpacing:2}}>選手を選択</div>
        <div style={{fontSize:12,color:"rgba(255,255,255,.5)",marginTop:2}}>自分の名前を選んで記録を開始</div>
      </div>

      <div style={{padding:"16px 16px 100px",maxWidth:480,margin:"0 auto"}}>
        {roster.length === 0 && !showForm && (
          <div style={{textAlign:"center",padding:"40px 20px",color:"rgba(255,255,255,.4)",fontSize:14}}>
            <div style={{fontSize:48,marginBottom:12}}>👤</div>
            まだ選手が登録されていません<br/>下のボタンから登録してください
          </div>
        )}

        {roster.map(a => {
          const recs = getRecords(a.id);
          const todayDone = !!recs[today]?.saved;
          return (
            <button key={a.id} onClick={()=>onSelect(a)}
              style={{width:"100%",background:"rgba(255,255,255,.06)",border:`2px solid ${todayDone?"#2ecc71":"rgba(255,255,255,.15)"}`,
                borderRadius:12,padding:"16px 18px",marginBottom:10,cursor:"pointer",display:"flex",alignItems:"center",gap:14,transition:"all .2s",textAlign:"left"}}>
              <div style={{width:48,height:48,borderRadius:"50%",background:"#f0e68c",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"Anton,sans-serif",fontSize:14,color:"#1c3a1c",flexShrink:0}}>
                {a.height ? `${a.height}` : "🏃"}
              </div>
              <div style={{flex:1}}>
                <div style={{fontWeight:900,fontSize:17,color:"#fff"}}>{a.name}</div>
                <div style={{fontSize:12,color:"rgba(255,255,255,.5)",marginTop:2}}>{a.position}{a.height ? ` • ${a.height}cm` : ""}{a.goal ? ` • ${a.goal==="bulk"?"💪増量":a.goal==="cut"?"🔥減量":"⚖️維持"}` : ""}</div>
              </div>
              {todayDone
                ? <div style={{fontSize:11,fontWeight:700,color:"#2ecc71",background:"rgba(46,204,113,.15)",padding:"4px 10px",borderRadius:20}}>✓ 記録済み</div>
                : <div style={{fontSize:11,fontWeight:700,color:"rgba(255,255,255,.3)",padding:"4px 10px"}}>未記録</div>}
            </button>
          );
        })}

        {/* New registration button */}
        <button onClick={()=>setShowForm(true)}
          style={{width:"100%",padding:"16px",borderRadius:12,border:"2px dashed rgba(240,230,140,.4)",background:"transparent",color:"#f0e68c",fontFamily:"'Noto Sans JP',sans-serif",fontSize:15,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,marginTop:4}}>
          ＋ 新しく選手登録する
        </button>
      </div>

      {/* Registration modal */}
      {showForm && (
        <div className="overlay" onClick={()=>setShowForm(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div style={{fontFamily:"Anton,sans-serif",fontSize:22,color:"#1c3a1c",letterSpacing:1,marginBottom:4}}>選手登録</div>
            <div style={{fontSize:12,color:"#8b7355",marginBottom:20}}>情報を入力してください</div>

            <div style={{marginBottom:14}}>
              <div style={{fontSize:11,fontWeight:700,color:"#1c3a1c",letterSpacing:1,marginBottom:6}}>氏名 *</div>
              <input className="ti" placeholder="例: 田中 颯太" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} style={{fontSize:16}} />
            </div>
            <div style={{marginBottom:14}}>
              <div style={{fontSize:11,fontWeight:700,color:"#1c3a1c",letterSpacing:1,marginBottom:6}}>身長</div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <input className="ti" placeholder="例: 175" type="number" min="100" max="230" value={form.height} onChange={e=>setForm(f=>({...f,height:e.target.value}))} style={{fontSize:16,flex:1}}/>
                <span style={{fontWeight:700,color:"#8b7355",fontSize:14,whiteSpace:"nowrap"}}>cm</span>
              </div>
            </div>
            <div style={{marginBottom:14}}>
              <div style={{fontSize:11,fontWeight:700,color:"#1c3a1c",letterSpacing:1,marginBottom:6}}>ポジション</div>
              <select className="si" value={form.position} onChange={e=>setForm(f=>({...f,position:e.target.value}))}>
                {POSITIONS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div style={{marginBottom:20}}>
              <div style={{fontSize:11,fontWeight:700,color:"#1c3a1c",letterSpacing:1,marginBottom:6}}>🎯 トレーニング目標</div>
              <div style={{display:"flex",gap:8}}>
                {[{v:"bulk",icon:"💪",label:"増量",desc:"筋肉・体重を増やす",color:"#e67e22"},{v:"maintain",icon:"⚖️",label:"維持",desc:"現状維持",color:"#2ecc71"},{v:"cut",icon:"🔥",label:"減量",desc:"体脂肪を減らす",color:"#3498db"}].map(g=>(
                  <button key={g.v} onClick={()=>setForm(f=>({...f,goal:g.v}))}
                    style={{flex:1,padding:"10px 6px",borderRadius:10,border:`2px solid ${form.goal===g.v?g.color:"#ddd"}`,background:form.goal===g.v?`${g.color}15`:"#f9f5ed",cursor:"pointer",textAlign:"center",transition:"all .2s"}}>
                    <div style={{fontSize:20,marginBottom:2}}>{g.icon}</div>
                    <div style={{fontSize:12,fontWeight:700,color:form.goal===g.v?g.color:"#555"}}>{g.label}</div>
                    <div style={{fontSize:9,color:"#999",marginTop:1}}>{g.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {err && <div style={{color:"#e74c3c",fontSize:13,fontWeight:700,marginBottom:12,padding:"8px 12px",background:"rgba(231,76,60,.1)",borderRadius:8}}>⚠️ {err}</div>}

            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>{setShowForm(false);setErr("");}}
                style={{flex:1,padding:"13px",border:"2px solid #ddd",borderRadius:10,background:"#f9f5ed",fontFamily:"'Noto Sans JP',sans-serif",fontSize:14,fontWeight:700,cursor:"pointer",color:"#8b7355"}}>
                キャンセル
              </button>
              <button onClick={register}
                style={{flex:2,padding:"13px",border:"none",borderRadius:10,background:"#1c3a1c",fontFamily:"Anton,sans-serif",fontSize:16,fontWeight:700,cursor:"pointer",color:"#f0e68c",letterSpacing:2}}>
                登録して開始 ⚾
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// COACH VIEW
// ════════════════════════════════════════════════════════════════
function CoachView({ onBack, onDetail }) {
  const today = todayKey();
  const [roster, setRoster] = useState(getRoster);
  const [allRecords, setAllRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [coachNote, setCoachNote] = useState(()=>localStorage.getItem("bb_coach_note")||"");
  const [coachTab, setCoachTab] = useState("team");

  // Supabaseから全データ取得
  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchRosterFromSupabase(),
      fetchAllRecordsFromSupabase()
    ]).then(([sbRoster, sbRecords]) => {
      // 選手リストをマージ
      if (sbRoster.length > 0) {
        const local = getRoster();
        const merged = [...sbRoster];
        local.forEach(a => { if (!merged.find(s => s.id === a.id)) merged.push(a); });
        saveRoster(merged);
        setRoster(merged);
      }
      setAllRecords(sbRecords);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const athleteData = roster.map(a => {
    // Supabaseのレコードを優先、なければlocalStorageを使用
    const sbRecs = allRecords.filter(r => r.athlete_id === a.id);
    const recsFromSupa = {};
    sbRecs.forEach(r => { recsFromSupa[r.record_date] = r.data; });
    const localRecs = getRecords(a.id);
    const recs = { ...localRecs, ...recsFromSupa };
    const todayRec = recs[today] || null;
    const allKeys = Object.keys(recs).sort((x,y)=>y.localeCompare(x));
    return { ...a, todayRec, allKeys, recs };
  });

  const recorded = athleteData.filter(a=>a.todayRec?.saved);
  const teamAvgWt = recorded.filter(a=>a.todayRec?.weight).length
    ? (recorded.filter(a=>a.todayRec?.weight).map(a=>parseFloat(a.todayRec.weight)).reduce((x,y)=>x+y,0)/recorded.filter(a=>a.todayRec?.weight).length).toFixed(1) : "--";
  const teamAvgSleep = recorded.filter(a=>a.todayRec?.sleep).length
    ? (recorded.filter(a=>a.todayRec?.sleep).map(a=>parseFloat(a.todayRec.sleep)).reduce((x,y)=>x+y,0)/recorded.filter(a=>a.todayRec?.sleep).length).toFixed(1) : "--";
  const teamAvgFatigue = recorded.length
    ? (recorded.map(a=>a.todayRec.fatigue??2).reduce((x,y)=>x+y,0)/recorded.length).toFixed(1) : "--";

  if (loading) return (
    <div style={{minHeight:"100vh",background:"#1c3a1c",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16}}>
      <div style={{fontSize:48}}>⚾</div>
      <div style={{fontFamily:"Anton,sans-serif",fontSize:20,color:"#f0e68c",letterSpacing:2}}>データ読み込み中...</div>
      <div style={{fontSize:12,color:"rgba(255,255,255,.5)"}}>Supabaseから全選手データを取得しています</div>
    </div>
  );

  return (
    <div style={{minHeight:"100vh",background:"#f5f0e8",fontFamily:"'Noto Sans JP',sans-serif"}}>
      <G/>
      <div className="hdr-navy">
        <button onClick={onBack} style={{background:"none",border:"none",color:"rgba(255,255,255,.4)",cursor:"pointer",fontSize:12,fontWeight:700,padding:0,marginBottom:6}}>← 戻る</button>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end"}}>
          <div>
            <div style={{fontSize:10,letterSpacing:3,color:"rgba(255,200,100,.7)",fontWeight:700,textTransform:"uppercase"}}>COACH DASHBOARD</div>
            <div style={{fontFamily:"Anton,sans-serif",fontSize:26,color:"#ffd700",letterSpacing:2}}>指導者ビュー</div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontFamily:"Anton,sans-serif",fontSize:32,color:"#fff",lineHeight:1}}>{pad(new Date().getDate())}</div>
            <div style={{fontSize:10,color:"rgba(255,255,255,.5)",fontWeight:700}}>{new Date().getFullYear()}/{pad(new Date().getMonth()+1)}({DAYS[new Date().getDay()]})</div>
          </div>
        </div>
      </div>

      <div className="ctabbr">
        {[["team","🏟 チーム全体"],["members","👥 選手個別"]].map(([id,lbl])=>(
          <button key={id} className={`ctabbtn ${coachTab===id?"on":""}`} onClick={()=>setCoachTab(id)}>{lbl}</button>
        ))}
      </div>

      <div style={{padding:"14px 14px 80px",maxWidth:520,margin:"0 auto"}}>

        {coachTab==="team" && <>
          {/* 記録状況 */}
          <div className="card navy">
            <div className="stitle">📊 本日の記録状況（{new Date().getMonth()+1}/{new Date().getDate()}）</div>
            <div style={{display:"flex",gap:10,marginBottom:14}}>
              {[["記録済み",recorded.length,"#1c3a1c","#f0f7f0","#b8d8b8"],["未提出",roster.length-recorded.length,"#d4a017","#fff8f0","#e0c090"],["総選手数",roster.length,"#2c1810","#f9f5ed","#e0d5c0"]].map(([lbl,val,c,bg,bc])=>(
                <div key={lbl} style={{flex:1,background:bg,borderRadius:10,padding:"12px 10px",textAlign:"center",border:`2px solid ${bc}`}}>
                  <div style={{fontFamily:"Anton,sans-serif",fontSize:32,color:c,lineHeight:1}}>{val}</div>
                  <div style={{fontSize:10,color:"#8b7355",fontWeight:700,marginTop:4}}>{lbl}</div>
                </div>
              ))}
            </div>
            {roster.filter(a=>!recorded.find(r=>r.id===a.id)).length>0 && (
              <div style={{background:"#fff8e1",borderRadius:8,padding:"10px 12px",border:"1px solid #ffe082"}}>
                <div style={{fontSize:11,fontWeight:700,color:"#f57f17",marginBottom:6}}>⚠️ 未提出の選手</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                  {roster.filter(a=>!recorded.find(r=>r.id===a.id)).map(a=>(
                    <span key={a.id} style={{background:"#fff3cd",border:"1px solid #ffc107",borderRadius:16,padding:"3px 10px",fontSize:12,fontWeight:700,color:"#856404"}}>{a.name}</span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* チーム平均 */}
          <div className="card red">
            <div className="stitle">📈 チーム平均（本日記録分）</div>
            <div style={{display:"flex",gap:10}}>
              {[["平均体重",teamAvgWt,"kg"],["平均睡眠",teamAvgSleep,"h"],["平均疲労度",teamAvgFatigue,"/ 4"]].map(([lbl,val,unit])=>(
                <div key={lbl} style={{flex:1,background:"#f9f5ed",borderRadius:8,padding:"10px 8px",textAlign:"center"}}>
                  <div style={{fontSize:10,color:"#8b7355",fontWeight:700,marginBottom:4}}>{lbl}</div>
                  <div style={{fontFamily:"Anton,sans-serif",fontSize:22,color:"#1c3a1c",lineHeight:1}}>{val}</div>
                  <div style={{fontSize:10,color:"#8b7355",marginTop:2}}>{unit}</div>
                </div>
              ))}
            </div>
          </div>

          {/* コンディション一覧 */}
          <div className="card gold">
            <div className="stitle">⚡ 本日のコンディション一覧</div>
            {recorded.length===0
              ? <div style={{textAlign:"center",padding:"16px 0",color:"#aaa",fontSize:13}}>本日の記録なし</div>
              : recorded.map(a=>(
                <div key={a.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderBottom:"1px solid #f0ebe0"}}>
                  <div style={{width:32,height:32,borderRadius:"50%",background:"#1c3a1c",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"Anton,sans-serif",fontSize:11,color:"#f0e68c",flexShrink:0}}>{a.height ? `${a.height}` : "🏃"}</div>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:700,fontSize:14}}>{a.name}</div>
                    <div style={{fontSize:11,color:"#8b7355"}}>{a.position} {a.todayRec?.weight&&`• ${a.todayRec.weight}kg`}</div>
                  </div>
                  <span style={{fontSize:12,fontWeight:700,color:FATIGUE_COLORS[a.todayRec.fatigue??2],background:FATIGUE_BG[a.todayRec.fatigue??2],padding:"3px 10px",borderRadius:20}}>
                    {FATIGUE_LABELS[a.todayRec.fatigue??2]}
                  </span>
                </div>
              ))
            }
          </div>

          {/* 指導メモ */}
          <div className="card blue">
            <div className="stitle">📝 指導メモ</div>
            <textarea className="ti" value={coachNote} onChange={e=>setCoachNote(e.target.value)}
              style={{minHeight:80,resize:"vertical",lineHeight:1.6}}
              placeholder="練習計画、気になる選手へのコメントなど…"/>
            <button onClick={()=>localStorage.setItem("bb_coach_note",coachNote)}
              style={{marginTop:8,padding:"9px 20px",background:"#2471a3",border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"'Noto Sans JP',sans-serif"}}>
              保存
            </button>
          </div>
        </>}

        {coachTab==="members" && <>
          <div style={{fontSize:11,fontWeight:700,color:"#8b7355",letterSpacing:1,textTransform:"uppercase",marginBottom:12}}>
            選手をタップして個人記録を確認 ({roster.length}名)
          </div>
          {roster.length===0 && (
            <div style={{textAlign:"center",padding:"40px 20px",color:"#aaa",fontSize:14}}>
              <div style={{fontSize:48,marginBottom:12}}>👤</div>選手が登録されていません
            </div>
          )}
          {athleteData.map(a=>{
            const fatigue = a.todayRec?.saved ? (a.todayRec.fatigue??2) : null;
            const needsAttention = fatigue!=null && fatigue>=3;
            return (
              <div key={a.id} className="athlete-row"
                style={{borderLeftColor:fatigue!=null?FATIGUE_COLORS[fatigue]:"#ccc"}}
                onClick={()=>onDetail(a)}>
                <div style={{width:44,height:44,borderRadius:"50%",background:"#1c3a1c",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"Anton,sans-serif",fontSize:13,color:"#f0e68c",flexShrink:0}}>{a.height ? `${a.height}` : "🏃"}</div>
                <div style={{flex:1}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                    <span style={{fontWeight:900,fontSize:16}}>{a.name}</span>
                    {needsAttention && <span style={{fontSize:10,fontWeight:700,color:"#e74c3c",background:"rgba(231,76,60,.1)",padding:"2px 8px",borderRadius:20}}>要注意</span>}
                  </div>
                  <div style={{fontSize:11,color:"#8b7355",marginBottom:6}}>{a.position} • {a.allKeys.length}日分の記録</div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                    {a.todayRec?.saved ? (
                      <>
                        {a.todayRec.weight&&<span style={{fontSize:11,background:"#f0f7f0",padding:"2px 8px",borderRadius:12,fontWeight:700,color:"#1c3a1c"}}>⚖ {a.todayRec.weight}kg</span>}
                        {a.todayRec.sleep&&<span style={{fontSize:11,background:"#f0f0ff",padding:"2px 8px",borderRadius:12,fontWeight:700,color:"#2471a3"}}>🌙 {a.todayRec.sleep}h</span>}
                        {calcKcal(a.todayRec)>0&&<span style={{fontSize:11,background:"#fff8f0",padding:"2px 8px",borderRadius:12,fontWeight:700,color:"#d4a017"}}>🍽 {calcKcal(a.todayRec)}kcal</span>}
                        {a.todayRec.practice&&<span style={{fontSize:11,background:"#f0f0ff",padding:"2px 8px",borderRadius:12,fontWeight:700,color:"#c0392b"}}>⚾ {a.todayRec.practice}h</span>}
                        {a.todayRec.pain?.length>0&&<span style={{fontSize:11,background:"#fde8e8",padding:"2px 8px",borderRadius:12,fontWeight:700,color:"#e74c3c"}}>🩹 {a.todayRec.pain.length}箇所</span>}
                      </>
                    ) : <span style={{fontSize:11,color:"#aaa"}}>本日未記録</span>}
                  </div>
                </div>
                <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4,flexShrink:0}}>
                  {fatigue!=null&&<span style={{fontSize:10,fontWeight:700,color:FATIGUE_COLORS[fatigue],background:FATIGUE_BG[fatigue],padding:"3px 8px",borderRadius:16}}>{FATIGUE_LABELS[fatigue]}</span>}
                  <span style={{fontSize:11,color:"#aaa"}}>詳細 ›</span>
                </div>
              </div>
            );
          })}
        </>}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// ATHLETE DETAIL (coach view)
// ════════════════════════════════════════════════════════════════
function AthleteDetail({ athlete, onBack }) {
  const recs = getRecords(athlete.id);
  const histKeys = Object.keys(recs).sort((a,b)=>b.localeCompare(a)).slice(0,60);
  const today = todayKey();
  const todayRec = recs[today];
  const [detailTab, setDetailTab] = useState("overview");

  // chart data helpers
  const chartData = (getter, limit=30) =>
    histKeys.slice(0,limit).reverse()
      .filter(k=>getter(recs[k])!=null && getter(recs[k])!=="")
      .map(k=>({ label: k.slice(5).replace("-","/"), v: parseFloat(getter(recs[k])) }))
      .filter(d=>!isNaN(d.v));

  const wtData      = chartData(r=>r?.weight);
  const sleepData   = chartData(r=>r?.sleep);
  const kcalData    = chartData(r=>calcKcal(r)||null);
  const practData   = chartData(r=>r?.practice);
  const fatigueData = chartData(r=>r?.fatigue!=null?r.fatigue:null);

  const wts   = histKeys.filter(k=>recs[k]?.weight).map(k=>parseFloat(recs[k].weight));
  const avgWt = wts.length?(wts.reduce((a,b)=>a+b,0)/wts.length).toFixed(1):"--";
  const slps  = histKeys.filter(k=>recs[k]?.sleep).map(k=>parseFloat(recs[k].sleep));
  const avgSl = slps.length?(slps.reduce((a,b)=>a+b,0)/slps.length).toFixed(1):"--";
  const totalPr = histKeys.map(k=>parseFloat(recs[k]?.practice)||0).reduce((a,b)=>a+b,0).toFixed(1);

  return (
    <div style={{minHeight:"100vh",background:"#f5f0e8",fontFamily:"'Noto Sans JP',sans-serif"}}>
      <G/>
      <div className="hdr-navy">
        <button onClick={onBack} style={{background:"none",border:"none",color:"rgba(255,255,255,.4)",cursor:"pointer",fontSize:12,fontWeight:700,padding:0,marginBottom:8}}>← 選手一覧</button>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          <div style={{width:56,height:56,borderRadius:"50%",background:"#f0e68c",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"Anton,sans-serif",fontSize:16,color:"#1c3a1c",flexShrink:0}}>{athlete.height ? `${athlete.height}cm` : "🏃"}</div>
          <div>
            <div style={{fontFamily:"Anton,sans-serif",fontSize:24,color:"#fff",letterSpacing:1}}>{athlete.name}</div>
            <div style={{fontSize:12,color:"rgba(255,255,255,.5)",marginTop:2}}>{athlete.position}{athlete.height ? ` • ${athlete.height}cm` : ""} • {histKeys.length}日分の記録</div>
          </div>
          {todayRec?.saved&&<div style={{marginLeft:"auto",fontSize:10,fontWeight:700,color:FATIGUE_COLORS[todayRec.fatigue??2],background:FATIGUE_BG[todayRec.fatigue??2],padding:"5px 12px",borderRadius:20}}>{FATIGUE_LABELS[todayRec.fatigue??2]}</div>}
        </div>
      </div>

      <div className="ctabbr">
        {[["overview","📊 今日"],["history","📅 履歴"],["trend","📈 グラフ"]].map(([id,lbl])=>(
          <button key={id} className={`ctabbtn ${detailTab===id?"on":""}`} onClick={()=>setDetailTab(id)}>{lbl}</button>
        ))}
      </div>

      <div style={{padding:"14px 14px 80px",maxWidth:520,margin:"0 auto"}}>

        {/* TODAY */}
        {detailTab==="overview"&&<>
          {!todayRec?.saved
            ? <div style={{textAlign:"center",padding:"60px 20px",color:"#8b7355",fontWeight:700}}><div style={{fontSize:48,marginBottom:12}}>📭</div>本日はまだ記録を提出していません</div>
            : <>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
                {[["⚖ 体重",todayRec.weight?`${todayRec.weight}kg`:"--","#1c3a1c"],["🌙 睡眠",todayRec.sleep?`${todayRec.sleep}h`:"--","#2471a3"],
                  ["🍽 カロリー",calcKcal(todayRec)?`${calcKcal(todayRec)}kcal`:"--","#d4a017"],["⚾ 練習",todayRec.practice?`${todayRec.practice}h`:"--","#c0392b"]
                ].map(([lbl,val,color])=>(
                  <div key={lbl} className="card" style={{borderTopColor:color,padding:14,textAlign:"center",marginBottom:0}}>
                    <div style={{fontSize:11,color:"#8b7355",fontWeight:700,marginBottom:6}}>{lbl}</div>
                    <div style={{fontFamily:"Anton,sans-serif",fontSize:26,color,lineHeight:1}}>{val}</div>
                  </div>
                ))}
              </div>
              <div className="card red" style={{marginBottom:12}}>
                <div className="stitle">コンディション</div>
                <div style={{display:"flex",alignItems:"center",gap:12}}>
                  <div style={{width:14,height:14,borderRadius:"50%",background:FATIGUE_COLORS[todayRec.fatigue??2]}}/>
                  <span style={{fontSize:18,fontWeight:900,color:FATIGUE_COLORS[todayRec.fatigue??2]}}>{FATIGUE_LABELS[todayRec.fatigue??2]}</span>
                </div>
                <div style={{display:"flex",gap:4,marginTop:10}}>
                  {[0,1,2,3,4].map(i=><div key={i} style={{flex:1,height:6,borderRadius:3,background:i<=(todayRec.fatigue??2)?FATIGUE_COLORS[todayRec.fatigue??2]:"#eee"}}/>)}
                </div>
              </div>
              {/* meals */}
              <div className="card gold">
                <div className="stitle">🍽 食事内容</div>
                {MEAL_META.map(({key,label,icon})=>{
                  const m=todayRec.meals?.[key];
                  if(!m?.kcal&&!m?.note) return null;
                  return <div key={key} style={{padding:"8px 0",borderBottom:"1px solid #f5f0e8"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:m?.note?4:0}}>
                      <span style={{fontWeight:700,fontSize:14}}>{icon} {label}</span>
                      {m?.kcal&&<span style={{background:"#c0392b",color:"#fff",fontFamily:"Anton,sans-serif",fontSize:13,padding:"2px 10px",borderRadius:20}}>{m.kcal}kcal</span>}
                    </div>
                    {m?.note&&<div style={{fontSize:12,color:"#666",lineHeight:1.5}}>{m.note}</div>}
                    {m?.items?.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:4}}>{m.items.map((it,ii)=><span key={ii} style={{background:"#f9f5ed",border:"1px solid #e0d5c0",fontSize:11,padding:"2px 8px",borderRadius:12,color:"#8b7355"}}>{it.name} {it.kcal}kcal</span>)}</div>}
                  </div>;
                })}
                {todayRec.snacks?.filter(s=>s.kcal||s.label).length>0&&<div style={{padding:"8px 0"}}>
                  <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>🥤 捕食・サプリ</div>
                  {todayRec.snacks.filter(s=>s.kcal||s.label).map((s,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"3px 0",color:"#555"}}><span>{s.label||"補食"}</span>{s.kcal&&<span style={{fontWeight:700,color:"#c0392b"}}>{s.kcal}kcal</span>}</div>)}
                </div>}
              </div>
              {todayRec.memo&&<div className="card blue"><div className="stitle">📝 選手メモ</div><div style={{fontSize:14,color:"#444",lineHeight:1.7,background:"#f9f5ed",borderRadius:8,padding:"12px 14px",borderLeft:"3px solid #2471a3"}}>{todayRec.memo}</div></div>}
              {todayRec.pain?.length>0&&(
                <div className="card" style={{borderTopColor:"#e74c3c"}}>
                  <div className="stitle" style={{color:"#e74c3c"}}>🩹 痛み・違和感</div>
                  <div style={{display:"flex",flexDirection:"column",gap:10}}>
                    {todayRec.pain.map(p=>(
                      <div key={p.id} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"8px 10px",background:PAIN_COLORS[p.level]+"15",borderRadius:8,border:`1px solid ${PAIN_COLORS[p.level]}44`}}>
                        <div style={{width:10,height:10,borderRadius:"50%",background:PAIN_COLORS[p.level],flexShrink:0,marginTop:3}}/>
                        <div>
                          <div style={{fontWeight:700,fontSize:14,color:PAIN_COLORS[p.level]}}>{p.label} <span style={{fontSize:12,color:"#8b7355",fontWeight:400}}>— {PAIN_LEVELS[p.level]}</span></div>
                          {p.note&&<div style={{fontSize:12,color:"#666",marginTop:2,lineHeight:1.5}}>{p.note}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>}
        </>}

        {/* HISTORY */}
        {detailTab==="history"&&<>
          {histKeys.length===0
            ? <div style={{textAlign:"center",padding:"60px 20px",color:"#aaa"}}>記録なし</div>
            : histKeys.map(k=>{
              const rec=recs[k]; const kcal=calcKcal(rec);
              return <div key={k} className="card" style={{borderLeftWidth:4,borderLeftColor:FATIGUE_COLORS[rec.fatigue??2],borderLeftStyle:"solid",padding:"12px 16px",marginBottom:10,borderTopColor:FATIGUE_COLORS[rec.fatigue??2]}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <div style={{fontWeight:700,fontSize:14}}>{fmtDate(k)}{k===today&&<span style={{marginLeft:6,fontSize:10,background:"#1c3a1c",color:"#f0e68c",padding:"2px 8px",borderRadius:10}}>TODAY</span>}</div>
                  <span style={{fontSize:11,fontWeight:700,color:FATIGUE_COLORS[rec.fatigue??2],background:FATIGUE_BG[rec.fatigue??2],padding:"3px 10px",borderRadius:20}}>{FATIGUE_LABELS[rec.fatigue??2]}</span>
                </div>
                <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
                  {[["体重",rec.weight,"kg"],["睡眠",rec.sleep,"h"],["カロリー",kcal||"","kcal"],["練習",rec.practice,"h"]].map(([lbl,val,unit])=>(
                    <div key={lbl}><div style={{fontSize:10,color:"#8b7355",fontWeight:700}}>{lbl}</div><div style={{fontFamily:"Anton,sans-serif",fontSize:18,color:val?"#2c1810":"#ccc"}}>{val||"--"}{val&&<span style={{fontSize:10,color:"#8b7355",marginLeft:2}}>{unit}</span>}</div></div>
                  ))}
                </div>
                {rec.memo&&<div style={{marginTop:8,fontSize:12,color:"#666",background:"#f9f5ed",padding:"6px 10px",borderRadius:6,lineHeight:1.5}}>{rec.memo}</div>}
                {rec.pain?.length>0&&(
                  <div style={{display:"flex",flexWrap:"wrap",gap:5,marginTop:8}}>
                    {rec.pain.map(p=>(
                      <span key={p.id} style={{fontSize:11,fontWeight:700,color:PAIN_COLORS[p.level],background:PAIN_COLORS[p.level]+"22",border:`1px solid ${PAIN_COLORS[p.level]}`,borderRadius:16,padding:"2px 8px"}}>
                        🩹{p.label} {PAIN_LEVELS[p.level]}
                      </span>
                    ))}
                  </div>
                )}
              </div>;
            })
          }
        </>}

        {/* TREND GRAPHS */}
        {detailTab==="trend"&&<>
          {/* summary */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
            {[["記録日数",`${histKeys.length}`,"日","#1c3a1c"],["平均体重",avgWt,"kg","#c0392b"],["平均睡眠",avgSl,"時間","#2471a3"],["総練習",totalPr,"時間","#d4a017"]].map(([lbl,val,unit,color])=>(
              <div key={lbl} className="sbox" style={{borderTop:`3px solid ${color}`}}>
                <div style={{fontSize:11,fontWeight:700,color:"#8b7355",marginBottom:6}}>{lbl}</div>
                <span style={{fontFamily:"Anton,sans-serif",fontSize:26,color,lineHeight:1}}>{val}</span>
                <span style={{fontSize:11,color:"#8b7355",fontWeight:700,marginLeft:4}}>{unit}</span>
              </div>
            ))}
          </div>

          {/* 体重 */}
          <div className="card red">
            <div className="stitle">⚖️ 体重トレンド</div>
            <LineChart data={wtData} color="#c0392b" dotColor="#c0392b" height={100} unit="kg"/>
          </div>

          {/* 睡眠 */}
          <div className="card blue">
            <div className="stitle">🌙 睡眠時間トレンド</div>
            <LineChart data={sleepData} color="#2471a3" dotColor="#2471a3" height={100} unit="h" targetLine={7} targetColor="rgba(46,204,113,.5)"/>
            <div style={{fontSize:10,color:"#aaa",marginTop:4}}>緑線 = 目標7時間</div>
          </div>

          {/* カロリー */}
          <div className="card gold">
            <div className="stitle">🍽️ 摂取カロリートレンド</div>
            <LineChart data={kcalData} color="#d4a017" dotColor="#d4a017" height={100} unit="kcal"/>
          </div>

          {/* 練習時間 */}
          <div className="card" style={{}}>
            <div className="stitle" style={{color:"#2471a3"}}>⚾ 練習時間トレンド</div>
            <LineChart data={practData} color="#1c3a1c" dotColor="#1c3a1c" height={100} unit="h"/>
          </div>

          {/* 疲労度 */}
          <div className="card">
            <div className="stitle" style={{color:"#e67e22"}}>⚡ 疲労度トレンド</div>
            <LineChart data={fatigueData} color="#e67e22" dotColor="#e74c3c" height={100} unit=""/>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#aaa",marginTop:2}}>
              <span>0 = 絶好調</span><span>4 = 限界</span>
            </div>
          </div>

          {/* コンディション分布 */}
          <div className="card">
            <div className="stitle">📊 コンディション分布</div>
            {FATIGUE_LABELS.map((lbl,i)=>{
              const cnt=histKeys.filter(k=>(recs[k]?.fatigue??2)===i).length;
              const pct=histKeys.length?Math.round(cnt/histKeys.length*100):0;
              return <div key={i} style={{marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                  <span style={{fontSize:13,fontWeight:700,color:FATIGUE_COLORS[i]}}>{lbl}</span>
                  <span style={{fontSize:12,fontWeight:700,color:"#8b7355"}}>{cnt}日 ({pct}%)</span>
                </div>
                <div style={{height:8,background:"#f0ebe0",borderRadius:4}}>
                  <div style={{width:`${pct}%`,height:"100%",background:FATIGUE_COLORS[i],borderRadius:4,transition:"width .5s ease"}}/>
                </div>
              </div>;
            })}
          </div>
          <div style={{textAlign:"center",padding:"16px 0",opacity:.1}}><div style={{fontSize:72}}>⚾</div></div>
        </>}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// PLAYER VIEW
// ════════════════════════════════════════════════════════════════
function PlayerView({ athlete, onBack }) {
  const TODAY = todayKey();
  const [tab, setTab]     = useState("today");
  const [records, setRecords] = useState(()=>getRecords(athlete.id));
  const [record, setRecord]   = useState(()=>{
    const s=getRecords(athlete.id); return s[todayKey()]||emptyRecord();
  });
  const [toast, setToast]     = useState("");
  const [expandedMeal, setExp]= useState(null);
  const fileRefs = useRef({});

  useEffect(()=>{
    if(toast){ const t=setTimeout(()=>setToast(""),2800); return ()=>clearTimeout(t); }
  },[toast]);

  const totalKcal=()=>{ let t=0; Object.values(record.meals).forEach(m=>{t+=parseFloat(m.kcal)||0;}); record.snacks.forEach(s=>{t+=parseFloat(s.kcal)||0;}); return t; };

  const save=()=>{
    const next={...records,[TODAY]:{...record,saved:true}};
    setRecords(next); saveRecords(athlete.id,next); setRecord(r=>({...r,saved:true}));
    syncRecordToSupabase(athlete, TODAY, {...record,saved:true}); // Supabaseに同期
    setToast("⚾ 記録を保存したぞ！");
  };

  const estimateMenu=(menuText,mealKey,snackIdx)=>{
    if(!menuText.trim()){setToast("メニューを入力してね！");return;}
    const result = estimateFromDB(menuText);
    const knownItems = result.items.filter(i=>!i.unknown);
    const unknownItems = result.unknowns;
    if(snackIdx!=null){
      setRecord(r=>{const s=[...r.snacks];s[snackIdx]={...s[snackIdx],kcal:String(result.total)};return{...r,snacks:s};});
    } else {
      setRecord(r=>({...r,meals:{...r.meals,[mealKey]:{...r.meals[mealKey],
        kcal:String(result.total),
        items:knownItems,
        note:knownItems.map(i=>`${i.name} ${i.kcal}kcal`).join(" / "),
      }}}));
    }
    if(unknownItems.length>0){
      setToast(`✅ ${result.total}kcal計算！（「${unknownItems[0]}」等はDB未登録）`);
    } else {
      setToast(`✅ ${result.total}kcalと計算！`);
    }
  };

  const analyzePhoto=(file,mealKey,snackIdx)=>{
    const setBusy=(v)=>setRecord(r=>{if(snackIdx!=null){const s=[...r.snacks];s[snackIdx]={...s[snackIdx],busy:v};return{...r,snacks:s};}return{...r,meals:{...r.meals,[mealKey]:{...r.meals[mealKey],busy:v}}};});
    setBusy(true);
    const reader=new FileReader();
    reader.onload=async(e)=>{
      const b64=e.target.result.split(",")[1];
      try{
        const json=await callClaudeImage(b64,file.type);
        setRecord(r=>{
          if(snackIdx!=null){const s=[...r.snacks];s[snackIdx]={...s[snackIdx],kcal:String(json.total||json.calories||0),img:e.target.result,busy:false};return{...r,snacks:s};}
          return{...r,meals:{...r.meals,[mealKey]:{...r.meals[mealKey],kcal:String(json.total||json.calories||0),items:json.items||[],note:json.description||(json.items||[]).map(i=>`${i.name} ${i.kcal}kcal`).join(" / "),img:e.target.result,busy:false}}};
        });
        setToast(`📸 約${json.total||json.calories}kcal！`);
      }catch(e){console.error("analyzePhoto error:",e);setBusy(false);setToast(`⚠️ 写真分析エラー: ${e.message?.slice(0,30)||"失敗"}`);;}
    };
    reader.readAsDataURL(file);
  };

  const addSnack=(label)=>{
    const found = label ? FOOD_DB.find(f=>f.n.includes(label)||label.includes(f.n.slice(0,3))) : null;
    const newSnack = emptySnack(label);
    if(found){ newSnack.items=[{name:found.n,kcal:found.k,unit:found.unit}]; newSnack.kcal=String(found.k); }
    setRecord(r=>({...r,snacks:[...r.snacks,newSnack]}));
  };
  const delSnack=(i)=>setRecord(r=>{const s=[...r.snacks];s.splice(i,1);return{...r,snacks:s};});
  const setSnack=(i,k,v)=>setRecord(r=>{const s=[...r.snacks];s[i]={...s[i],[k]:v};return{...r,snacks:s};});
  const setMeal=(mk,k,v)=>setRecord(r=>({...r,meals:{...r.meals,[mk]:{...r.meals[mk],[k]:v}}}));

  const histKeys=Object.keys(records).sort((a,b)=>b.localeCompare(a)).slice(0,30);
  const weekData=Array.from({length:7},(_,i)=>{const d=new Date();d.setDate(d.getDate()-(6-i));const k=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;return{k,label:DAYS[d.getDay()],rec:records[k]};});
  const wts=histKeys.filter(k=>records[k]?.weight).map(k=>parseFloat(records[k].weight));
  const avgWt=wts.length?(wts.reduce((a,b)=>a+b,0)/wts.length).toFixed(1):"--";
  const calcTotal=(rec)=>{let t=0;if(rec?.meals)Object.values(rec.meals).forEach(m=>{t+=parseFloat(m.kcal)||0;});if(rec?.snacks)rec.snacks.forEach(s=>{t+=parseFloat(s.kcal)||0;});return t||(rec?.calories?parseInt(rec.calories):0);};

  // chart data
  const chartData=(getter,limit=20)=>histKeys.slice(0,limit).reverse().filter(k=>getter(records[k])!=null&&getter(records[k])!=="").map(k=>({label:k.slice(5).replace("-","/"),v:parseFloat(getter(records[k]))})).filter(d=>!isNaN(d.v));
  const wtData=chartData(r=>r?.weight);
  const sleepData=chartData(r=>r?.sleep);
  const kcalData=chartData(r=>calcKcal(r)||null);
  const practData=chartData(r=>r?.practice);

  return (
    <div style={{minHeight:"100vh",background:"#1a1a1a",fontFamily:"'Noto Sans JP',sans-serif",color:"#2c1810"}}>
      <G/>
      <div style={{minHeight:"100vh",background:"#f5f0e8"}}>
        <div className="hdr-green">
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
            <div>
              <button onClick={onBack} style={{background:"none",border:"none",color:"rgba(240,230,140,.6)",cursor:"pointer",fontSize:12,fontWeight:700,padding:0,marginBottom:4}}>← モード選択</button>
              <div style={{fontSize:10,letterSpacing:3,color:"rgba(240,230,140,.7)",fontWeight:700,textTransform:"uppercase",marginBottom:2}}>⚾ PLAYER LOG</div>
              <div style={{fontFamily:"Anton,sans-serif",fontSize:20,color:"#f0e68c",letterSpacing:1}}>{athlete.name}</div>
              <div style={{fontSize:11,color:"rgba(255,255,255,.5)",marginTop:1}}>{athlete.position}{athlete.height ? ` • ${athlete.height}cm` : ""}</div>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontFamily:"Anton,sans-serif",fontSize:40,color:"#fff",lineHeight:1}}>{pad(new Date().getDate())}</div>
              <div style={{fontSize:11,color:"rgba(255,255,255,.6)",fontWeight:700}}>{new Date().getFullYear()}/{pad(new Date().getMonth()+1)} ({DAYS[new Date().getDay()]})</div>
            </div>
          </div>
          <div style={{display:"flex",gap:6,marginTop:14}}>
            {weekData.map(({k,label,rec})=>(
              <div key={k} style={{flex:1,textAlign:"center"}}>
                <div style={{fontSize:10,color:"rgba(255,255,255,.5)",fontWeight:700,marginBottom:4}}>{label}</div>
                <div style={{width:"100%",aspectRatio:"1",borderRadius:"50%",background:rec?.saved?FATIGUE_COLORS[rec.fatigue??2]:"rgba(255,255,255,.1)",border:k===TODAY?"2px solid #f0e68c":"2px solid transparent",display:"flex",alignItems:"center",justifyContent:"center"}}>
                  {rec?.saved&&<span style={{fontSize:7,fontWeight:900,color:"#fff"}}>✓</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="tabbr">
          {[["today","📋 今日"],["history","📅 履歴"],["stats","📊 統計"]].map(([id,lbl])=>(
            <button key={id} className={`tabbtn ${tab===id?"on":""}`} onClick={()=>setTab(id)}>{lbl}</button>
          ))}
        </div>

        <div style={{padding:"14px 14px 100px",maxWidth:480,margin:"0 auto"}}>

          {/* TODAY */}
          {tab==="today"&&<>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
              <div className="card">
                <div className="stitle">⚖️ 体重</div>
                <input className="ni" type="number" placeholder="75" step="0.1" value={record.weight} onChange={e=>setRecord(r=>({...r,weight:e.target.value}))}/>
                <div style={{fontSize:11,color:"#8b7355",fontWeight:700,marginTop:4,textAlign:"right"}}>kg</div>
              </div>
              <div className="card">
                <div className="stitle">🌙 睡眠</div>
                <input className="ni" type="number" placeholder="7.5" step="0.5" min="0" max="24" value={record.sleep} onChange={e=>setRecord(r=>({...r,sleep:e.target.value}))}/>
                <div style={{fontSize:11,color:"#8b7355",fontWeight:700,marginTop:4,textAlign:"right"}}>時間</div>
                {record.sleep&&<div style={{marginTop:6,height:5,background:"#f0ebe0",borderRadius:3}}><div style={{height:"100%",borderRadius:3,transition:"width .3s",width:`${Math.min(100,parseFloat(record.sleep)/10*100)}%`,background:parseFloat(record.sleep)>=7?"#2ecc71":parseFloat(record.sleep)>=5?"#f0c040":"#e74c3c"}}/></div>}
              </div>
            </div>

            <div className="card blue">
              <div className="stitle">⚾ 予定練習時間</div>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <input className="ni" type="number" placeholder="2.5" step="0.5" min="0" value={record.practice} onChange={e=>setRecord(r=>({...r,practice:e.target.value}))} style={{flex:1}}/>
                <span style={{fontWeight:700,color:"#8b7355"}}>時間</span>
              </div>
              {record.practice&&<div style={{marginTop:10,display:"flex",gap:4}}>{Array.from({length:Math.round(Math.min(8,parseFloat(record.practice)||0)*2)},(_,i)=><div key={i} style={{flex:1,height:6,borderRadius:3,background:i<6?"#2471a3":i<12?"#1a6040":"#c0392b"}}/>)}</div>}
            </div>

            <div className="card red">
              <div className="stitle">⚡ 今日のコンディション</div>
              <div style={{display:"flex",gap:6}}>
                {FATIGUE_LABELS.map((lbl,i)=>(
                  <button key={i} className="fbtn" onClick={()=>setRecord(r=>({...r,fatigue:i}))}
                    style={{color:record.fatigue===i?FATIGUE_COLORS[i]:"#aaa",borderColor:record.fatigue===i?FATIGUE_COLORS[i]:"transparent",background:record.fatigue===i?FATIGUE_BG[i]:"#f9f5ed",transform:record.fatigue===i?"scale(1.05)":"scale(1)"}}>
                    {lbl.split(" ")[1]}<br/><span style={{fontSize:9}}>{lbl.split(" ")[0]}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="card gold">
              <div className="stitle">🍽️ 食事記録</div>
              {(()=>{
                const current=totalKcal();
                const target=calcTargetKcal(athlete.height, record.weight||athlete.weight, record.practice, athlete.goal||"maintain");
                const pct=target?Math.min(100,Math.round(current/target.target*100)):0;
                const color=pct<60?"#e74c3c":pct<80?"#e67e22":pct<100?"#f0c040":"#2ecc71";
                return (<>
                  {target&&<div style={{background:"linear-gradient(135deg,#0d2010,#1a3520)",borderRadius:12,padding:"12px 14px",marginBottom:12,border:"1.5px solid #2e5c2e"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                      <div>
                        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
                          <div style={{fontSize:10,color:"rgba(240,230,140,.7)",fontWeight:700,letterSpacing:1}}>🎯 本日の目標</div>
                          <div style={{fontSize:10,fontWeight:700,padding:"1px 7px",borderRadius:20,background:`${target.goalColor}25`,color:target.goalColor,border:`1px solid ${target.goalColor}60`}}>{target.goalIcon}{target.goalLabel}</div>
                          <div style={{fontSize:9,color:"rgba(255,255,255,.35)"}}>{target.practiceLabel}</div>
                        </div>
                        <div style={{fontFamily:"Anton,sans-serif",fontSize:28,color:"#f0e68c",lineHeight:1}}>
                          {target.target.toLocaleString()}<span style={{fontSize:12,fontWeight:400,marginLeft:4}}>kcal</span>
                        </div>
                        <div style={{fontSize:10,color:"rgba(255,255,255,.5)",marginTop:3}}>
                          身長{athlete.height}cm × 体重{record.weight||"--"}kg × 練習{record.practice||0}h
                        </div>
                        <div style={{fontSize:9,color:`${target.goalColor}aa`,marginTop:2}}>{target.goalTip}</div>
                      </div>
                      {current>0&&<div style={{textAlign:"right"}}>
                        <div style={{fontSize:10,color:"rgba(255,255,255,.5)",marginBottom:2}}>摂取済み</div>
                        <div style={{fontFamily:"Anton,sans-serif",fontSize:22,color:color}}>{current.toLocaleString()}</div>
                        <div style={{fontSize:10,color:color,fontWeight:700}}>{pct}%</div>
                      </div>}
                    </div>
                    {/* プログレスバー */}
                    <div style={{height:8,background:"rgba(255,255,255,.1)",borderRadius:4,overflow:"hidden"}}>
                      <div style={{height:"100%",width:`${pct}%`,background:color,borderRadius:4,transition:"width .5s"}}/>
                    </div>
                    {/* PFC内訳 */}
                    <div style={{display:"flex",gap:8,marginTop:8}}>
                      {[["🍚 糖質",target.carb+"g",target.carbKcal],["🥩 タンパク質",target.protein+"g",target.protKcal],["🫒 脂質",target.fat+"g",target.fatKcal]].map(([lbl,sub,k])=>(
                        <div key={lbl} style={{flex:1,background:"rgba(255,255,255,.06)",borderRadius:8,padding:"5px 6px",textAlign:"center"}}>
                          <div style={{fontSize:9,color:"rgba(255,255,255,.5)"}}>{lbl}</div>
                          <div style={{fontSize:12,fontWeight:700,color:"#f0e68c"}}>{sub}</div>
                          <div style={{fontSize:9,color:"rgba(255,255,255,.4)"}}>{k}kcal</div>
                        </div>
                      ))}
                    </div>
                    {current>0&&target&&current<target.target*0.7&&<div style={{marginTop:8,padding:"5px 10px",background:"rgba(231,76,60,.15)",borderRadius:8,fontSize:11,color:"#e74c3c",fontWeight:700,textAlign:"center"}}>
                      ⚠️ あと{(target.target-current).toLocaleString()}kcal必要！しっかり食べよう
                    </div>}
                    {current>0&&target&&current>=target.target&&<div style={{marginTop:8,padding:"5px 10px",background:"rgba(46,204,113,.15)",borderRadius:8,fontSize:11,color:"#2ecc71",fontWeight:700,textAlign:"center"}}>
                      ✅ 目標達成！よく食べた！
                    </div>}
                  </div>}
                  {!target&&current>0&&<div className="totbar"><span style={{color:"#f0e68c",fontWeight:700,fontSize:13}}>合計摂取カロリー</span><span style={{fontFamily:"Anton,sans-serif",fontSize:24,color:"#fff",letterSpacing:2}}>{current.toLocaleString()}<span style={{fontSize:13,marginLeft:4}}>kcal</span></span></div>}
                  {!target&&!current&&<div style={{fontSize:11,color:"#8b7355",marginBottom:8,padding:"8px 10px",background:"#f5f0e8",borderRadius:8}}>💡 体重・練習時間を入力すると目標カロリーが表示されます</div>}
                </>);
              })()}
              {MEAL_META.map(({key:mk,label,icon})=>{
                const meal=record.meals[mk];const isOpen=expandedMeal===mk;
                return <div key={mk} className="msec" style={{borderColor:isOpen?"#1c3a1c":"#e0d5c0"}}>
                  <div className="mhdr" onClick={()=>setExp(isOpen?null:mk)}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:18}}>{icon}</span><span style={{fontWeight:700,fontSize:14}}>{label}</span></div>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>{meal.kcal&&<span className="kbadge">{meal.kcal}kcal</span>}<span style={{color:"#aaa",fontSize:18,display:"inline-block",transform:isOpen?"rotate(90deg)":"none",transition:".2s"}}>›</span></div>
                  </div>
                  {isOpen&&<div className="mbdy">
                    <FoodSearchBox
                      addedItems={meal.items||[]}
                      onAdd={(food)=>{
                        const newItems=[...(meal.items||[]),{name:food.n,kcal:food.k,unit:food.unit}];
                        const total=newItems.reduce((s,i)=>s+i.kcal,0);
                        setMeal(mk,"items",newItems);
                        setMeal(mk,"kcal",String(total));
                        setMeal(mk,"note",newItems.map(i=>`${i.name} ${i.kcal}kcal`).join(" / "));
                      }}
                      onRemove={(idx)=>{
                        const newItems=(meal.items||[]).filter((_,i)=>i!==idx);
                        const total=newItems.reduce((s,i)=>s+i.kcal,0);
                        setMeal(mk,"items",newItems);
                        setMeal(mk,"kcal",total>0?String(total):"");
                        setMeal(mk,"note",newItems.map(i=>`${i.name} ${i.kcal}kcal`).join(" / "));
                      }}
                    />
                    <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:8,marginTop:4}}>
                      <input className="ni" type="number" placeholder="kcal" style={{flex:1,fontSize:18,padding:"8px 12px"}} value={meal.kcal} onChange={e=>setMeal(mk,"kcal",e.target.value)}/>
                      <span style={{fontWeight:700,color:"#8b7355",fontSize:13}}>kcal 直接入力も可</span>
                    </div>
                    <textarea className="ti" placeholder="メモ" style={{fontSize:13,minHeight:40,resize:"vertical"}} value={meal.note} onChange={e=>setMeal(mk,"note",e.target.value)}/>
                    <input type="file" accept="image/*" capture="environment" style={{display:"none"}} ref={el=>fileRefs.current[mk]=el} onChange={e=>e.target.files?.[0]&&analyzePhoto(e.target.files[0],mk,null)}/>
                    <button className="pbtn" disabled={meal.busy} onClick={()=>fileRefs.current[mk]?.click()}>
                      {meal.busy?<><span className="spin">⟳</span> 分析中...</>:<>📸 写真を撮って自動記録</>}
                    </button>
                    {meal.img&&<img src={meal.img} style={{width:"100%",borderRadius:8,marginTop:8,maxHeight:130,objectFit:"cover"}}/>}
                  </div>}
                </div>;
              })}

              <div style={{marginTop:14}}>
                <div style={{fontWeight:700,fontSize:13,marginBottom:8,display:"flex",alignItems:"center",gap:6}}>
                  🥤 捕食・サプリ
                  {record.snacks.some(s=>s.kcal)&&<span className="kbadge" style={{fontSize:11}}>{record.snacks.reduce((a,s)=>a+(parseFloat(s.kcal)||0),0)}kcal</span>}
                </div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
                  {QUICK_SNACKS.map(l=><button key={l} className="schip" onClick={()=>addSnack(l)}>+ {l}</button>)}
                  <button className="schip" onClick={()=>addSnack("")} style={{borderColor:"#1c3a1c",color:"#1c3a1c"}}>+ その他</button>
                </div>
                {record.snacks.map((snack,idx)=>(
                  <div key={idx} className="msec" style={{marginBottom:8}}>
                    <div style={{padding:"10px 12px"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                        <span style={{fontWeight:700,fontSize:13,color:"#2c1810"}}>{snack.label||"補食・サプリ"}</span>
                        <button onClick={()=>delSnack(idx)} style={{background:"none",border:"none",cursor:"pointer",color:"#e74c3c",fontSize:20,fontWeight:700,padding:"0 4px"}}>×</button>
                      </div>
                      <FoodSearchBox
                        addedItems={snack.items||[]}
                        onAdd={(food)=>{
                          const newItems=[...(snack.items||[]),{name:food.n,kcal:food.k,unit:food.unit}];
                          const total=newItems.reduce((s,i)=>s+i.kcal,0);
                          setSnack(idx,"items",newItems);
                          setSnack(idx,"kcal",String(total));
                          setSnack(idx,"label",snack.label||food.n);
                        }}
                        onRemove={(i)=>{
                          const newItems=(snack.items||[]).filter((_,j)=>j!==i);
                          const total=newItems.reduce((s,it)=>s+it.kcal,0);
                          setSnack(idx,"items",newItems);
                          setSnack(idx,"kcal",total>0?String(total):"");
                        }}
                      />
                      <div style={{display:"flex",gap:8,alignItems:"center",marginTop:4}}>
                        <input className="ni" type="number" placeholder="kcal" style={{flex:1,fontSize:15,padding:"7px 10px"}} value={snack.kcal} onChange={e=>setSnack(idx,"kcal",e.target.value)}/>
                        <span style={{fontSize:12,color:"#8b7355",fontWeight:700}}>kcal 直接入力も可</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <PainCard pain={record.pain||[]} onChange={v=>setRecord(r=>({...r,pain:v}))}/>



            <div className="card">
              <div className="stitle">📝 メモ・気づき</div>
              <textarea className="ti" placeholder="気になること、体の状態…" value={record.memo} onChange={e=>setRecord(r=>({...r,memo:e.target.value}))} style={{minHeight:80,resize:"vertical",lineHeight:1.6}}/>
            </div>
            <button className="savebtn" onClick={save}>{record.saved?"✓ 更新する":"⚾ 記録を保存！"}</button>
          </>}

          {/* HISTORY */}
          {tab==="history"&&<>
            {histKeys.length===0
              ? <div style={{textAlign:"center",padding:"60px 20px",color:"#8b7355",fontWeight:700}}><div style={{fontSize:48,marginBottom:12}}>⚾</div>まだ記録がないぞ！<br/>今日から始めよう！</div>
              : histKeys.map(k=>{
                const rec=records[k];const totalC=calcTotal(rec);
                return <div key={k} className="hcard" style={{borderLeftColor:FATIGUE_COLORS[rec.fatigue??2]}} onClick={()=>{setRecord({...emptyRecord(),...rec});setTab("today");}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                    <div style={{fontWeight:700,fontSize:15}}>{fmtDate(k)}</div>
                    <div style={{fontSize:12,fontWeight:700,color:FATIGUE_COLORS[rec.fatigue??2],background:FATIGUE_BG[rec.fatigue??2],padding:"3px 10px",borderRadius:20}}>{FATIGUE_LABELS[rec.fatigue??2]}</div>
                  </div>
                  <div style={{display:"flex",gap:16}}>
                    {[["体重",rec.weight,"kg"],["睡眠",rec.sleep,"h"],["カロリー",totalC||"","kcal"],["練習",rec.practice,"h"]].map(([lbl,val,unit])=>(
                      <div key={lbl}><div style={{fontSize:10,color:"#8b7355",fontWeight:700}}>{lbl}</div><div style={{fontFamily:"Anton,sans-serif",fontSize:18,color:val?"#2c1810":"#ccc"}}>{val||"--"}{val&&<span style={{fontSize:10,color:"#8b7355",marginLeft:2}}>{unit}</span>}</div></div>
                    ))}
                  </div>
                  {rec.pain?.length>0&&(
                    <div style={{display:"flex",flexWrap:"wrap",gap:5,marginTop:8}}>
                      {rec.pain.map(p=>(
                        <span key={p.id} style={{fontSize:11,fontWeight:700,color:PAIN_COLORS[p.level],background:PAIN_COLORS[p.level]+"22",border:`1px solid ${PAIN_COLORS[p.level]}`,borderRadius:16,padding:"2px 8px"}}>
                          🩹{p.label} {PAIN_LEVELS[p.level]}
                        </span>
                      ))}
                    </div>
                  )}
                  {k!==TODAY&&<div style={{fontSize:11,color:"#8b7355",marginTop:6}}>タップして編集 ›</div>}
                </div>;
              })
            }
          </>}

          {/* STATS */}
          {tab==="stats"&&<>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
              {[["記録日数",`${histKeys.length}`,"日","#1c3a1c"],["平均体重",avgWt,"kg","#c0392b"],
                ["平均睡眠",histKeys.filter(k=>records[k]?.sleep).length?(histKeys.filter(k=>records[k]?.sleep).map(k=>parseFloat(records[k].sleep)).reduce((a,b)=>a+b,0)/histKeys.filter(k=>records[k]?.sleep).length).toFixed(1):"--","時間","#2471a3"],
                ["総練習",histKeys.map(k=>parseFloat(records[k]?.practice)||0).reduce((a,b)=>a+b,0).toFixed(1),"時間","#d4a017"]
              ].map(([lbl,val,unit,color])=>(
                <div key={lbl} className="sbox" style={{borderTop:`3px solid ${color}`}}>
                  <div style={{fontSize:11,fontWeight:700,color:"#8b7355",letterSpacing:1,marginBottom:6}}>{lbl}</div>
                  <span style={{fontFamily:"Anton,sans-serif",fontSize:28,color,lineHeight:1}}>{val}</span>
                  <span style={{fontSize:12,color:"#8b7355",fontWeight:700,marginLeft:4}}>{unit}</span>
                </div>
              ))}
            </div>

            {/* 体重折れ線 */}
            <div className="card red">
              <div className="stitle">⚖️ 体重トレンド</div>
              <LineChart data={wtData} color="#c0392b" dotColor="#c0392b" height={100} unit="kg"/>
            </div>

            {/* 睡眠折れ線 */}
            <div className="card blue">
              <div className="stitle">🌙 睡眠時間トレンド</div>
              <LineChart data={sleepData} color="#2471a3" dotColor="#2471a3" height={100} unit="h" targetLine={7} targetColor="rgba(46,204,113,.5)"/>
              <div style={{fontSize:10,color:"#aaa",marginTop:4}}>緑線 = 目標7時間</div>
            </div>

            {/* カロリー折れ線 */}
            <div className="card gold">
              <div className="stitle">🍽️ 摂取カロリートレンド</div>
              <LineChart data={kcalData} color="#d4a017" dotColor="#d4a017" height={100} unit="kcal"/>
            </div>

            {/* 練習時間折れ線 */}
            <div className="card">
              <div className="stitle" style={{color:"#1c3a1c"}}>⚾ 練習時間トレンド</div>
              <LineChart data={practData} color="#1c3a1c" dotColor="#1c3a1c" height={100} unit="h"/>
            </div>

            {/* コンディション分布 */}
            <div className="card">
              <div className="stitle">⚡ コンディション分布</div>
              {FATIGUE_LABELS.map((lbl,i)=>{
                const cnt=histKeys.filter(k=>(records[k]?.fatigue??2)===i).length;
                const pct=histKeys.length?Math.round(cnt/histKeys.length*100):0;
                return <div key={i} style={{marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                    <span style={{fontSize:13,fontWeight:700,color:FATIGUE_COLORS[i]}}>{lbl}</span>
                    <span style={{fontSize:12,fontWeight:700,color:"#8b7355"}}>{cnt}日 ({pct}%)</span>
                  </div>
                  <div style={{height:8,background:"#f0ebe0",borderRadius:4}}><div style={{width:`${pct}%`,height:"100%",background:FATIGUE_COLORS[i],borderRadius:4,transition:"width .5s ease"}}/></div>
                </div>;
              })}
            </div>
            <div style={{textAlign:"center",padding:"20px 0",opacity:.12}}><div style={{fontSize:72}}>⚾</div></div>
          </>}
        </div>
      </div>
      {toast&&<div className="toast">{toast}</div>}
    </div>
  );
}
