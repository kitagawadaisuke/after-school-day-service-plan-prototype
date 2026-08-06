export const DOMAIN_META = {
  health: {
    id: "health",
    name: "健康・生活",
    short: "健康",
    color: "#769072",
    soft: "#e2eadc",
    description: "健康状態、生活リズム、身支度、環境の構造化"
  },
  motor: {
    id: "motor",
    name: "運動・感覚",
    short: "運動",
    color: "#b57e4c",
    soft: "#f2e4d5",
    description: "姿勢・動作、運動、感覚の活用と環境調整"
  },
  cognition: {
    id: "cognition",
    name: "認知・行動",
    short: "認知",
    color: "#6e7f9f",
    soft: "#e1e6ef",
    description: "状況理解、見通し、情報処理、行動の調整"
  },
  language: {
    id: "language",
    name: "言語・コミュニケーション",
    short: "ことば",
    color: "#a15f6e",
    soft: "#f0dfe3",
    description: "理解と表出、本人に合う伝達手段、相互作用"
  },
  social: {
    id: "social",
    name: "人間関係・社会性",
    short: "社会性",
    color: "#4f8588",
    soft: "#dcebea",
    description: "安心・信頼、他者理解、仲間や集団への参加"
  }
};

export const INDICATOR_META = {
  selfExpression: {
    name: "気持ちを伝える",
    short: "希望・援助要求",
    description: "言葉・カード・身振りで状態や希望を伝える"
  },
  transition: {
    name: "活動を切り替える",
    short: "見通し・切替",
    description: "予定や手順を確認し、次の行動を始める"
  },
  groupParticipation: {
    name: "集団に参加する",
    short: "仲間との参加",
    description: "役割や相談を通じて小集団に参加する"
  },
  regulation: {
    name: "気持ちを整える",
    short: "自己調整",
    description: "休憩や環境調整を選び、活動方法を整える"
  }
};

export const DEMO_PROFILE = {
  id: "demo-a",
  displayName: "Aさん",
  legalName: "Aさん（仮名）",
  grade: "小学4年生",
  ageLabel: "9歳（デモ）",
  birthDate: "2016-08-18",
  recipientNumber: "DEMO-0001",
  guardianName: "保護者A（仮名）",
  serviceName: "みらいステップ（デモ事業所）",
  serviceType: "放課後等デイサービス",
  managerName: "児童発達支援管理責任者（確認前）",
  usePattern: "月・水・金を中心に週3回",
  standardSchedule: "学校授業日 15:30〜17:30／学校休業日 10:00〜16:00",
  planStart: "2026-06-01",
  planEnd: "2026-11-30",
  reviewDate: "2026-11-30",
  createdDate: "2026-05-30",
  assessmentDate: "2026-05-29",
  currentPlanContext: "既存計画と2026年4〜5月の日誌を用いた、次期計画見直しの原案",
  interests: ["ブロック・工作", "地図や乗り物", "少人数のボール遊び"],
  strengths: [
    "興味のある活動では、工夫しながら続けられる",
    "手順が見えると、自分で確認して動ける場面がある",
    "落ち着いた場面では、自分の考えを言葉で伝えられる",
    "共通の目的や役割があると、友達とのやり取りが続きやすい"
  ],
  personWish: "工作やボール遊びを友達と楽しみたい。分からないときに聞けるようになりたい。",
  familyWish: "疲れや困り感を早めに伝える方法を増やしたい。身支度を自分で確認できる場面を少しずつ増やしたい。",
  caveat: "すべて架空のデモ設定です。診断名は設定していません。実運用では本人・家族との面接内容に置き換えます。"
};

function record({
  date,
  activity,
  mood,
  physical = "体調良好",
  observation,
  support,
  response,
  familyNote,
  domains,
  tags,
  indicators,
  time = "15:30〜17:30",
  staff = "佐藤（デモ）"
}) {
  return {
    id: `J-${date.replaceAll("-", "")}`,
    date,
    attendance: "出席",
    time,
    activity,
    mood,
    physical,
    observation,
    support,
    response,
    familyNote,
    staff,
    domains,
    tags,
    indicators
  };
}

export const DEMO_JOURNALS = [
  record({
    date: "2026-04-06",
    activity: "新学期の予定確認",
    mood: "少し不安",
    observation: "入室後、予定表の前で約40秒止まり、「今日は何から？」と職員に尋ねた。",
    support: "「おやつ・宿題・自由活動」の3工程を提示し、宿題とおやつの順を本人が選べるようにした。",
    response: "おやつを指差して選び、約2分後に準備を始めた。活動中に予定表を2回、自分から確認した。",
    familyNote: "新学期初週のため、家庭でも予定を確認することが増えているとのこと。視覚的な予定が役立った事実を共有した。",
    domains: ["health", "cognition", "language"],
    tags: ["visual_schedule", "transition", "help_request", "daily_living"],
    indicators: { selfExpression: 2, transition: 2, groupParticipation: 2, regulation: 2 }
  }),
  record({
    date: "2026-04-08",
    activity: "体育室でのボール活動",
    mood: "楽しみ",
    observation: "開始の笛が鳴った後、耳を覆って壁際へ移動し、約90秒その場で待った。",
    support: "体育室の静かな端、小さいボール、見学の3つから参加方法を選べるようにした。",
    response: "小さいボールを選んで8分間参加し、「小さい音ならできる」と伝えた。",
    familyNote: "大きな音の場面で、参加方法を本人が選べたことを共有した。",
    domains: ["motor", "health", "language"],
    tags: ["sensory", "choice", "self_expression", "regulation"],
    indicators: { selfExpression: 3, transition: 2, groupParticipation: 2, regulation: 2 }
  }),
  record({
    date: "2026-04-10",
    activity: "共同ブロック",
    mood: "楽しみ",
    observation: "友達が置いたブロックを動かすと取り戻し、「それ僕の」と普段より大きめの声で言った。",
    support: "「一緒に作る」「場所を分ける」の2案を図で提示し、互いの役割を整理した。",
    response: "場所を分ける案を選んだ後、友達と3往復の相談をして建物を完成させた。",
    familyNote: "役割と場所を見える形にすると相談が続いたことを共有した。",
    domains: ["social", "cognition", "language"],
    tags: ["peer_interaction", "visual_support", "problem_solving"],
    indicators: { selfExpression: 2, transition: 2, groupParticipation: 2, regulation: 2 }
  }),
  record({
    date: "2026-04-13",
    activity: "来所時の身支度",
    mood: "疲れ気味",
    physical: "本人から「疲れた」と申告あり",
    observation: "鞄を背負ったままマットに座り、「疲れた」と話した。",
    support: "5分休憩後、鞄・手洗い・予定確認・水分のカードを提示した。",
    response: "4工程中3工程を、職員の言葉掛け2回で実施した。水分は自分でカードを確認した。",
    familyNote: "週明けで疲れがあった様子。休憩後に身支度へ移れたことを共有した。",
    domains: ["health", "cognition"],
    tags: ["daily_living", "visual_schedule", "fatigue", "transition"],
    indicators: { selfExpression: 2, transition: 2, groupParticipation: 1, regulation: 2 }
  }),
  record({
    date: "2026-04-15",
    activity: "順番のあるボードゲーム",
    mood: "楽しみ",
    observation: "自分の順番の前に、中央の駒へ手を伸ばすことが2回あった。",
    support: "順番カードを中央に置き、「次は○○さん」と伝える例を1回示した。",
    response: "4周参加し、最後は自分から「次は○○さん」と友達へ伝えた。",
    familyNote: "順番カードがあると、最後まで参加できたことを共有した。",
    domains: ["social", "cognition", "language"],
    tags: ["peer_interaction", "turn_taking", "visual_support"],
    indicators: { selfExpression: 3, transition: 3, groupParticipation: 2, regulation: 3 }
  }),
  record({
    date: "2026-04-17",
    activity: "縄跳びとキャッチボール",
    mood: "おだやか",
    observation: "縄跳びを1回試した後、「難しい」と伝えて活動を止めた。",
    support: "距離を本人が選べるキャッチボールを代替活動として提案した。",
    response: "近い距離を選び、10回中6回捕球した。「もう1回」と継続を希望した。",
    familyNote: "難しさを言葉で伝え、別の運動を選べたことを共有した。",
    domains: ["motor", "health", "language"],
    tags: ["motor", "choice", "self_expression", "strength"],
    indicators: { selfExpression: 3, transition: 3, groupParticipation: 2, regulation: 3 }
  }),
  record({
    date: "2026-04-20",
    activity: "自由工作",
    mood: "楽しみ",
    observation: "完成形を決めずに材料を切り始め、途中で手が止まって材料を見続けた。",
    support: "「選ぶ・並べる・固定する」の3工程カードを机上に置いた。",
    response: "カードを2回確認して作品を完成させ、タイマー後に友達へはさみを渡した。",
    familyNote: "工程が見えると、自分で戻って進められたことを共有した。",
    domains: ["cognition", "motor", "social"],
    tags: ["visual_schedule", "planning", "transition", "peer_interaction"],
    indicators: { selfExpression: 2, transition: 3, groupParticipation: 2, regulation: 3 }
  }),
  record({
    date: "2026-04-22",
    activity: "宿題・文章題",
    mood: "おだやか",
    observation: "文章題を3回消し、職員を2回見たが、約4分間は援助を求めなかった。",
    support: "「ヒントください」カードを示し、職員へ渡す方法を1回実演した。",
    response: "カードを渡して支援を求め、図を使った説明後に3問中2問を解いた。",
    familyNote: "援助要求カードを使ったことを共有。家庭で同じ方法を使うかは家族と相談することにした。",
    domains: ["language", "cognition"],
    tags: ["help_request", "visual_support", "learning"],
    indicators: { selfExpression: 2, transition: 2, groupParticipation: 2, regulation: 2 }
  }),
  record({
    date: "2026-04-24",
    activity: "公園遊びの終了",
    mood: "楽しみ",
    observation: "5分前予告後も、終了合図でボールを続け、「あと1回」と言った。",
    support: "最後の1回で終えることを一緒に確認し、片付けカードを提示した。",
    response: "最後の1回を終え、約4分でボールを戻して他児の列へ合流した。",
    familyNote: "終了方法を具体的にすると移りやすかったことを共有した。",
    domains: ["cognition", "motor", "social"],
    tags: ["transition", "visual_schedule", "peer_interaction"],
    indicators: { selfExpression: 3, transition: 2, groupParticipation: 2, regulation: 2 }
  }),
  record({
    date: "2026-04-27",
    activity: "おやつ作り",
    mood: "おだやか",
    observation: "食材のにおいを嗅ぎ、「食べたくない」と伝えた。",
    support: "試食は任意と説明し、計量・混ぜる役割から選べるようにした。",
    response: "計量を選び、衛生手順3工程を指差し確認1回で実施した。",
    familyNote: "食べることを強制せず、調理工程には参加できたことを共有した。",
    domains: ["health", "motor", "cognition", "language"],
    tags: ["sensory", "choice", "daily_living", "self_expression"],
    indicators: { selfExpression: 3, transition: 3, groupParticipation: 2, regulation: 3 }
  }),
  record({
    date: "2026-04-29",
    activity: "図書館への外出",
    mood: "少し不安",
    observation: "人数の多い入口で立ち止まり、「人が多い」と言った。",
    support: "館内図、静かな席、探す本を2冊に絞った予定を入口で確認した。",
    response: "職員の近くで2冊を探し、貸出手続きまで参加した。",
    familyNote: "混雑を言葉で伝え、見通しを確認して外出を続けられたことを共有した。",
    domains: ["cognition", "health", "social", "language"],
    tags: ["sensory", "visual_schedule", "community", "self_expression"],
    indicators: { selfExpression: 3, transition: 2, groupParticipation: 2, regulation: 2 }
  }),
  record({
    date: "2026-05-01",
    activity: "集団活動の投票",
    mood: "気持ちが高ぶる",
    observation: "希望した工作が選ばれず、投票札を置いて椅子を反対へ向けた。",
    support: "気持ちを言葉で確認し、タイム係と見学から参加方法を選べるようにした。",
    response: "タイム係を10分担当し、残り時間を2回友達へ伝えた。",
    familyNote: "希望と違う結果でも、役割を選ぶと参加を続けられたことを共有した。",
    domains: ["language", "cognition", "social"],
    tags: ["emotion_regulation", "choice", "peer_interaction", "self_expression"],
    indicators: { selfExpression: 2, transition: 2, groupParticipation: 2, regulation: 2 }
  }),
  record({
    date: "2026-05-04",
    activity: "祝日の長時間利用",
    mood: "疲れ気味",
    physical: "家族から、前夜の睡眠が普段より短かったとの情報あり",
    observation: "活動開始時に横になり、声をかけると「眠い」と答えた。",
    support: "活動量を減らし、パズル・休憩・短い散歩から本人が選べるようにした。",
    response: "パズル後に5分の散歩を選び、「今日はこれでいい」と活動量を伝えた。",
    familyNote: "睡眠情報を踏まえ活動量を調整した。本人が終了量を伝えられたことを共有した。",
    domains: ["health", "motor", "cognition", "language"],
    tags: ["fatigue", "choice", "self_expression", "regulation"],
    indicators: { selfExpression: 3, transition: 3, groupParticipation: 2, regulation: 3 },
    time: "10:00〜16:00"
  }),
  record({
    date: "2026-05-06",
    activity: "新しい利用児とのブロック",
    mood: "おだやか",
    observation: "相手の遊びを約3分見ていたが、自分からは近づかなかった。",
    support: "互いに乗り物が好きなことを伝え、質問例を1回だけ示した。",
    response: "「何線が好き？」から3往復会話し、後半は自分から「ここつなげる？」と尋ねた。",
    familyNote: "共通の興味を入口に、会話と共同活動が続いたことを共有した。",
    domains: ["social", "language"],
    tags: ["peer_interaction", "shared_interest", "strength"],
    indicators: { selfExpression: 3, transition: 3, groupParticipation: 3, regulation: 3 }
  }),
  record({
    date: "2026-05-08",
    activity: "飲み物をこぼした場面",
    mood: "おだやか",
    observation: "コップを倒した後、約20秒動かず、「もうやらない」と言った。",
    support: "失敗を責めず、「拭く・入れ直す」の2工程と職員が手伝える内容を示した。",
    response: "「タオルください」と伝え、自分で机を拭いた後、飲み物を入れ直した。",
    familyNote: "困った直後に援助を求め、やり直せたことを共有した。",
    domains: ["cognition", "health", "language"],
    tags: ["help_request", "problem_solving", "daily_living", "regulation"],
    indicators: { selfExpression: 3, transition: 3, groupParticipation: 2, regulation: 3 }
  }),
  record({
    date: "2026-05-11",
    activity: "来所時の身支度",
    mood: "おだやか",
    observation: "4工程のチェック表を見ながら、鞄・手洗い・予定・水分の順に進めた。",
    support: "職員は言葉で指示せず、未確認だった水分の欄を1回指差した。",
    response: "4工程を完了し、最後に自分でチェック表を裏返した。",
    familyNote: "言葉掛けなしで身支度を進め、環境的な手掛かり1回で完了したことを共有した。",
    domains: ["health", "cognition"],
    tags: ["daily_living", "visual_schedule", "independence", "transition"],
    indicators: { selfExpression: 3, transition: 4, groupParticipation: 2, regulation: 3 }
  }),
  record({
    date: "2026-05-13",
    activity: "チームボール",
    mood: "気持ちが高ぶる",
    observation: "判定について「ずるい」と言い、コートから約2m離れた。",
    support: "2分休憩と、「ルールを確認したい」という言い方を提示した。",
    response: "約3分後に戻り、「もう一回ルール教えて」と伝え、その後7分間参加した。",
    familyNote: "意見の違いで一度離れた後、言葉で確認して戻れたことを共有した。",
    domains: ["social", "motor", "language", "cognition"],
    tags: ["peer_interaction", "emotion_regulation", "help_request", "motor"],
    indicators: { selfExpression: 3, transition: 3, groupParticipation: 3, regulation: 3 }
  }),
  record({
    date: "2026-05-15",
    activity: "避難訓練",
    mood: "少し不安",
    observation: "警報音で耳を覆った。職員の矢印提示を見ると、避難位置へ移動した。",
    support: "防音具と静かな振り返り場所を用意し、訓練終了をカードで示した。",
    response: "「音が急でびっくり」と説明し、4分休憩後に終わりの会へ参加した。",
    familyNote: "突然の音への反応と、防音具・終了カードが役立ったことを共有した。",
    domains: ["motor", "health", "language", "cognition"],
    tags: ["sensory", "self_expression", "regulation", "visual_support"],
    indicators: { selfExpression: 3, transition: 3, groupParticipation: 2, regulation: 3 }
  }),
  record({
    date: "2026-05-18",
    activity: "調理活動",
    mood: "楽しみ",
    observation: "必要な赤い材料が友達側にある場面で、相手を見ながら待っていた。",
    support: "「赤いの取って」の要求文を指差せる位置に置いた。",
    response: "「赤いの取って」と依頼し、受け取り後に礼を伝えた。道具の受け渡しが3回続いた。",
    familyNote: "必要な物を友達へ依頼し、やり取りが続いたことを共有した。",
    domains: ["language", "health", "social"],
    tags: ["help_request", "peer_interaction", "daily_living"],
    indicators: { selfExpression: 3, transition: 3, groupParticipation: 3, regulation: 3 }
  }),
  record({
    date: "2026-05-20",
    activity: "宿題・疲労時の選択",
    mood: "疲れ気味",
    physical: "本人から「学校でたくさん走って疲れた」と申告あり",
    observation: "予定表を確認したが宿題を開かず、「学校でたくさん走って疲れた」と話した。",
    support: "10分休憩後、「1問・別活動・終了」から本人が選べるようにした。",
    response: "1問を選んで実施し、2問目は「今日はここまで」と伝えた。",
    familyNote: "疲労を自分から伝え、量を選べたことを共有した。宿題の実施量は家庭と調整する。",
    domains: ["cognition", "health", "language"],
    tags: ["fatigue", "self_expression", "choice", "regulation"],
    indicators: { selfExpression: 4, transition: 3, groupParticipation: 2, regulation: 3 }
  }),
  record({
    date: "2026-05-22",
    activity: "自由遊びの相談",
    mood: "おだやか",
    observation: "友達にブロックを提案して断られた。約10秒後、「じゃあ、あとで」と答えた。",
    support: "職員は別の活動候補を指差して示すだけにし、会話には入らなかった。",
    response: "別の友達へ絵を提案し、12分間一緒に活動した。",
    familyNote: "断られた後に気持ちを切り替え、別の相手へ提案できたことを共有した。",
    domains: ["social", "cognition", "language"],
    tags: ["peer_interaction", "emotion_regulation", "independence", "strength"],
    indicators: { selfExpression: 3, transition: 3, groupParticipation: 4, regulation: 4 }
  }),
  record({
    date: "2026-05-25",
    activity: "障害物コース",
    mood: "楽しみ",
    observation: "周囲の声が大きくなった時、自分から休憩カードを掲示板へ置いた。",
    support: "静かな場所と、少人数の時間帯に再開できることを確認した。",
    response: "4分休憩し、少人数になってから戻ってコースを2周した。",
    familyNote: "休憩カードを自分から使い、再開方法も選べたことを共有した。",
    domains: ["motor", "health", "cognition", "language"],
    tags: ["sensory", "help_request", "regulation", "choice"],
    indicators: { selfExpression: 4, transition: 3, groupParticipation: 3, regulation: 4 }
  }),
  record({
    date: "2026-05-27",
    activity: "終わりの会",
    mood: "おだやか",
    observation: "今日の出来事を尋ねると、最初は「ボール」と一語で答えた。",
    support: "「何が・どうだった」の2つの手掛かりを提示した。",
    response: "「キャッチが3回続いてうれしかった」と説明し、友達の話も最後まで聞いた。",
    familyNote: "手掛かりがあると、出来事と気持ちを文章で伝えられたことを共有した。",
    domains: ["language", "social"],
    tags: ["self_expression", "peer_interaction", "reflection", "strength"],
    indicators: { selfExpression: 4, transition: 3, groupParticipation: 3, regulation: 3 }
  }),
  record({
    date: "2026-05-29",
    activity: "雨天による予定変更",
    mood: "少し不安",
    observation: "公園中止を知って「えー」と言い、変更後の予定カードを見た。",
    support: "10分前に変更カードと、屋内ボール・工作の2案を提示した。",
    response: "約3分後に屋内ボールを選んだ。持物4項目中3項目を自分で確認し、水筒は職員へ援助を求めた。",
    familyNote: "急な変更でも選択肢から活動を決め、持物確認を進められたことを共有した。",
    domains: ["motor", "health", "cognition", "language", "social"],
    tags: ["transition", "visual_schedule", "help_request", "daily_living", "peer_interaction"],
    indicators: { selfExpression: 3, transition: 3, groupParticipation: 3, regulation: 3 }
  })
];

export function cloneDemoData() {
  return {
    profile: structuredClone(DEMO_PROFILE),
    journals: structuredClone(DEMO_JOURNALS)
  };
}
