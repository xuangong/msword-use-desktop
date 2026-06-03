/**
 * Polish-style preset prompts. Ported verbatim from msword-use v1
 * (src/msword_use/llm/prompts.py) so the same writing styles are produced.
 */

export const POLISH_PRESETS: Record<string, string> = {
  公文:
    "你是党政机关公文写作专家。改写要求：" +
    "1) 语言简洁、客观、规范，避免口语和情绪化表达；" +
    "2) 优先使用被动句和无主句，弱化个人视角；" +
    "3) 使用标准公文术语（如'拟'、'特此通知'、'予以'、'按照'等）；" +
    "4) 段落首句突出主题；" +
    "5) 保留原文事实和数据，不臆造内容；" +
    "6) 不增加新段落，保持原段落数。",
  合同:
    "你是法律文书改写专家，目标是合同条款。改写要求：" +
    "1) 严谨、无歧义，每个名词指代明确；" +
    "2) 关键术语首次出现给出定义（视上下文需要）；" +
    "3) 用'甲方'/'乙方'等中性主体替代人名（除非签字段）；" +
    "4) 时态明确，使用'应当'/'不得'/'有权'等规范助动词；" +
    "5) 不臆造条款内容，仅改写表达。",
  论文:
    "你是学术论文改写专家。改写要求：" +
    "1) 第三人称、客观语气，避免'我'/'我们觉得'；" +
    "2) 优先使用被动语态描述方法和结果；" +
    "3) 使用学术词汇（'研究表明'、'据此推断'、'相较而言'等）；" +
    "4) 长句拆分以提升可读性，但保留专业性；" +
    "5) 保留原文论据和引用意图，不增删观点。",
  文案:
    "你是营销文案改写专家。改写要求：" +
    "1) 生动、有节奏感，可适度使用短句和排比；" +
    "2) 强调用户价值和情感共鸣，弱化平铺直叙；" +
    "3) 关键卖点放在段首或单独成句；" +
    "4) 可适度加入 CTA 引导（如'立即体验'、'马上了解'）；" +
    "5) 保留原文核心信息，不夸大宣传。",
  商务:
    "你是商务文档改写专家。改写要求：" +
    "1) 专业、礼貌、结构清晰；" +
    "2) 重点信息前置，结论先行；" +
    "3) 避免冗余客套，但保持必要的礼仪用语；" +
    "4) 数据/事实陈述客观准确；" +
    "5) 保留原文意图，不改变结论。",
};

export type PolishPreset = keyof typeof POLISH_PRESETS | "custom";

export interface PolishSystemArgs {
  preset: PolishPreset;
  customStyle?: string;
  extraInstruction?: string;
}

export function polishSystemPrompt(args: PolishSystemArgs): string {
  let base =
    "你的任务是改写用户提供的中文文字。" +
    "严格只输出改写后的文字本身，不要加引号、不要加解释、不要加标题。\n\n";

  if (args.preset === "custom") {
    if (!args.customStyle) throw new Error("preset='custom' requires customStyle");
    base += `风格要求：${args.customStyle}\n`;
  } else {
    const desc = POLISH_PRESETS[args.preset];
    if (!desc) throw new Error(`Unknown polish preset: ${args.preset}`);
    base += desc + "\n";
  }

  if (args.extraInstruction) {
    base += `\n额外要求：${args.extraInstruction}\n`;
  }
  return base;
}

export interface PolishUserArgs {
  text: string;
  contextBefore?: string;
  contextAfter?: string;
}

export function polishUserMessage(args: PolishUserArgs): string {
  const parts: string[] = [];
  if (args.contextBefore) {
    parts.push(`【上文（仅参考，不改写）】\n${args.contextBefore}\n`);
  }
  parts.push(`【需改写】\n${args.text}`);
  if (args.contextAfter) {
    parts.push(`\n【下文（仅参考，不改写）】\n${args.contextAfter}`);
  }
  parts.push("\n请输出改写后的【需改写】部分。");
  return parts.join("\n");
}
