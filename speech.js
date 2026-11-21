export const MAX_SPOKEN = 120

const OPENERS = {
  ask: '漂泊者，可以请你帮我确认一下吗？',
  final: '我把这一轮的要点整理好了。',
}
export const NOTICES = Object.freeze({
  ask: '漂泊者，有件事想请你确认。请看看对话里的问题吧。',
  final: '漂泊者，这一轮的答复就在对话里。请慢慢看。',
  plan: '漂泊者，计划已写在对话里。可以请你看看，再决定是否继续吗？',
})
const MORE_QUESTIONS = '其他问题也在对话里。'
// Defense in depth for brief mode, not a guarantee that prose contains no sensitive data.
const SENSITIVE = /(?:密码|口令|验证码|取件码|核销码|安全码|解锁码|识别码|密钥|令牌|秘钥|凭据|私钥|身份证|银行卡|手机号|住址|password|passwd|passphrase|\b(?:pin|otp)\b|(?:verification|access|security|pickup)[\s_-]+code|api[\s_-]*key|secret|token|credential|private[\s_-]*key|bearer|authorization|\b(?:sk|rk|ghp|gho|github_pat|xox[baprs])[-_][a-z0-9_-]{8,}\b|\bAKIA[A-Z0-9]{16}\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b\d{7,}\b|\b[a-z0-9_+/=-]{28,}\b)/iu
const CONCLUSION = /^(?:(?:简而言之|总之|结论|总结|结果|最终结果|测试结果|验证结果|目前|下一步|已(?:经)?(?:完成|实现|修复|安装|通过|更新|创建)|仍|尚未|无法|未能)|(?:in short|summary|conclusion|result|next step|verified|implemented|fixed)\b)/iu
const COMMAND = /^(?:\$\s|>\s|(?:sudo|curl|wget|git|pnpm|npm|npx|yarn|brew|pip3?|node|python3?|bash|sh|zsh|dsh|chmod|docker|kubectl|ffplay|export|cd|ls|rm|mv|cp)\s|(?:const|let|function|import|return)\s+|[\w.-]+=)/iu
const TECHNICAL = /(?:\s--[a-z][\w-]*|\s&&\s|\s\|\s|\$\(|<\||\|>|[{}]|^\s*at\s+\S+|^\d{4}-\d{2}-\d{2}[T ])/iu
const LENGTH = (value) => Array.from(value).length

function plainLines(value) {
  if (typeof value !== 'string') return []
  const lines = []
  let fence = null
  for (let line of value.slice(0, 12_000).split(/\r?\n/)) {
    const indentedCode = /^(?: {4}|\t)/.test(line)
    line = line.replace(/[\p{Cc}\p{Cf}]/gu, ' ').normalize('NFKC').trim()
    const marker = line.match(/^(?:>\s*|(?:[-+*]|\d+[.)])\s+)*(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null
      continue
    }
    if (fence || !line || indentedCode || /^\|/.test(line)) continue
    // A section heading by itself isn't a spoken conclusion; preserve a heading with inline prose.
    if (/^#{1,6}\s/.test(line) && !/[:。!?].*\p{L}|[。!?]$/u.test(line)) continue
    // Handle Markdown before finding sentence boundaries; don't send remote URLs or filesystem paths.
    line = line
      .replace(/^#{1,6}\s+|^>\s+|^(?:[-+*]|\d+[.)])\s+/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, ' ')
      .replace(/(?:\b[a-z][a-z\d+.-]*:\/\/|\bwww\.)[^\s，。！？；、)）]+/giu, ' ')
    // Check before dropping code spans so a secret label isn't stripped while its value remains.
    if (SENSITIVE.test(line) || COMMAND.test(line)) continue
    line = line
      .replace(/`+[^`]*`+/g, ' ')
      .replace(/(?:[a-z]:[\\/]|(?:~|\.{1,2})?\/)[^\s，。！？；、)）]+/giu, ' ')
      .replace(/\b[\w.-]+(?:[\\/][\w.-]+)+(?:\b|(?=\s|$))/gu, ' ')
      .replace(/[\[\]`*_~<>|]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s+([，。！？；、,.!?;])/g, '$1')
      .trim()
    if (!TECHNICAL.test(line) && /[\p{L}]/u.test(line)) lines.push(line)
  }
  return lines
}

function sentences(line) {
  return line.split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+(?=[\p{L}\p{N}])/u)
    .map(segment => segment.trim()).filter(segment => /\p{L}/u.test(segment))
    .map(segment => /[。！？!?；;.]$/u.test(segment) ? segment : `${segment}。`)
}

function excerpt(text, budget, preferConclusion, maxSentences) {
  const parts = plainLines(text).flatMap(sentences)
  const start = preferConclusion ? Math.max(0, parts.findIndex(part => CONCLUSION.test(part))) : 0
  const picked = []
  // Preserve a complete question/conclusion rather than truncating a decision mid-sentence.
  for (const part of parts.slice(start, start + maxSentences)) {
    const candidate = [...picked, part].join(' ')
    if (LENGTH(candidate) > budget) break
    picked.push(part)
  }
  return picked.join(' ')
}

export function questionSpeech(questions, mode) {
  if (!questions?.length) return ''
  const first = questions[0]
  if (first.intent?.kind === 'approval') return ''
  if (first.intent?.kind === 'plan-review') return NOTICES.plan
  if (mode !== 'brief') return NOTICES.ask
  const more = questions.length > 1 ? MORE_QUESTIONS : ''
  const part = excerpt(first.question, MAX_SPOKEN - LENGTH(OPENERS.ask + more), false, 2)
  return part ? `${OPENERS.ask}${part}${more}` : NOTICES.ask
}

export function finalSpeech(text, mode) {
  if (mode !== 'brief') return NOTICES.final
  const part = excerpt(text, MAX_SPOKEN - LENGTH(OPENERS.final), true, 2)
  return part ? `${OPENERS.final}${part}` : NOTICES.final
}
