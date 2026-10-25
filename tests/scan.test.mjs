// 本地测试：从油猴脚本提取 scanStudyTaskCards，用真实日志卡片数据验证
// 运行：node dev-scan-test.mjs （测试完删除，不入库）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));

const src = readFileSync(join(here, '..', 'xue-autowatch.user.js'), 'utf8');
const m = src.match(/function scanStudyTaskCards\(\) \{[\s\S]*?\n  \}/);
if (!m) {
  console.error('!! 未找到 scanStudyTaskCards 函数');
  process.exit(1);
}

// ---- 极简 DOM 桩 ----
function el(cls, ...kids) {
  return {
    className: cls,
    kids,
    get textContent() {
      return this.kids.map((k) => (typeof k === 'string' ? k : k.textContent)).join('');
    },
  };
}
const body = { className: '', kids: [] };
function walk(node, fn) {
  (node.kids || []).forEach((k) => {
    if (typeof k !== 'string') {
      fn(k);
      walk(k, fn);
    }
  });
}
function qsa(sel, root) {
  const rootEl = root || body;
  const out = [];
  sel.split(',').map((s) => s.trim()).forEach((part) => {
    if (part === '*') walk(rootEl, (n) => out.push(n));
    else if (part.startsWith('.')) {
      const cls = part.slice(1);
      walk(rootEl, (n) => {
        if (String(n.className || '').split(/\s+/).includes(cls)) out.push(n);
      });
    }
  });
  return out;
}
const qs = (s, r) => qsa(s, r)[0] || null;
const text = (x) => ((x && x.textContent) || '').replace(/\s+/g, ' ').trim();
const isVisible = () => true;

const scanStudyTaskCards = new Function('qsa', 'qs', 'text', 'isVisible', m[0] + '\nreturn scanStudyTaskCards;')(
  qsa,
  qs,
  text,
  isVisible
);

// ---- 真实卡片数据（来自用户日志 2026-10-25 03:47 诊断输出） ----
body.kids = [
  // 分组头（plan-item，非任务卡）：应被排除
  el('plan-item active', '学习任务'),
  el('plan-item', 'IDP课程'),
  // 已完成卡（course-item，100%）
  el(
    'course-item common-item',
    el('', '100%'),
    el('title', '2026年安全生产月安全教育线上培训'),
    el('', '目标天数：无'),
    el('', '21057人已注册')
  ),
  // 未完成卡：无100%、无已完成字样。真实DOM里"目标天数：无1973人已注册"是同一个文本节点
  // （用户日志中它曾被当成任务标题 —— 要复现的 bug）
  el(
    'course-item common-item',
    el('title', '2026年网络安全意识培训'),
    el('', '目标天数：无1973人已注册')
  ),
  // 进行中卡（学习中）→ 未完成；meta 同样连在一起
  el(
    'course-item common-item',
    el('', '学习中'),
    el('title', '“金融为民 消保先行”文化学习行动'),
    el('', '目标天数：无1289人已注册')
  ),
  // 已完成卡但 meta 连写且比标题长（100%卡真实结构）
  el(
    'course-item common-item',
    el('', '100%'),
    el('title', '中国特色金融文化'),
    el('', '目标天数：无18882人已注册')
  ),
  // 带进度 3/5 的卡 → 未完成（分子<分母）
  el(
    'course-item common-item',
    el('', '已完成3/5'),
    el('title', '集团财务条线阳光学堂必修课程（2026年三季度）-2'),
    el('', '目标天数：无')
  ),
  // 首页课程卡（无状态字样）→ 未完成，标题应为课程名
  el(
    'course-item common-item',
    el('title', '开年第一课：用第一性原理破局2026'),
    el('', '学时:2'),
    el('', '12949')
  ),
];

const cards = scanStudyTaskCards();
console.log('=== 扫描结果 ===');
cards.forEach((c) => console.log(`  [${c.finished ? '已完成' : '未完成'}] ${c.title}`));

// ---- 断言 ----
const results = [];
function expect(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
}
const byTitle = (kw) => cards.find((c) => c.title.includes(kw));

expect('分组头"学习任务"被排除', !byTitle('学习任务') || byTitle('学习任务').title.length > 8, 'plan-item 不应被当任务卡');
expect('分组头"IDP课程"被排除', !cards.some((c) => c.title === 'IDP课程'), 'plan-item 不应被当任务卡');
expect('100%卡=已完成', byTitle('安全生产月') && byTitle('安全生产月').finished === true);
expect('网络安全卡=未完成', byTitle('网络安全') && byTitle('网络安全').finished === false);
expect('网络安全卡标题不含"目标天数"垃圾', byTitle('网络安全') && !byTitle('网络安全').title.includes('目标天数'));
expect('学习中卡=未完成', byTitle('消保先行') && byTitle('消保先行').finished === false);
expect('进度3/5卡=未完成', byTitle('财务条线') && byTitle('财务条线').finished === false);
expect('无状态卡=未完成且标题正确', byTitle('第一性原理') && byTitle('第一性原理').finished === false);
expect('卡片总数=6(不含分组头)', cards.length === 6, `实际 ${cards.length}`);
expect('中国特色金融文化卡=已完成且标题正确', byTitle('中国特色金融文化') && byTitle('中国特色金融文化').finished === true);

const failed = results.filter((r) => !r.pass);
console.log('\n=== 断言 ===');
results.forEach((r) => console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : '  → ' + (r.detail || '')}`));
console.log(failed.length === 0 ? '\n全部通过 ✓' : `\n${failed.length} 项失败 ✗`);
process.exit(failed.length === 0 ? 0 : 1);
