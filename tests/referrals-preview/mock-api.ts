// Deliberately no fetch(): this preview cannot reach a live backend.
const qr = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1kAAAAASUVORK5CYII=';
export const summary = { invite_code: "TEST2345", invitation_url: "https://example.invalid/invite/TEST2345", invited_count: 12, reward_credits: 240, invitation_reward_credits: 20, enabled: true, direct_rate_bps: 1000, indirect_rate_bps: 500, minimum_withdrawal_fen: 10000, available_fen: 25850, frozen_fen: 10000, earned_fen: 65850, paid_fen: 30000, withdrawal_open: true, timezone: "Asia/Shanghai", server_time: "2026-09-04T00:00:00Z", next_open_at: "2026-09-10T16:00:00Z" };
export type ReferralSummary = typeof summary;
const testUsers = [
  { id: '11111111-1111-4111-8111-111111111111', pid: null, display_name: '清林 · 示例邀请人' },
  { id: '22222222-2222-4222-8222-222222222222', pid: '11111111-1111-4111-8111-111111111111', display_name: '广川 · 示例创作者' },
  { id: '33333333-3333-4333-8333-333333333333', pid: '22222222-2222-4222-8222-222222222222', display_name: '小夏 · 示例下级' },
  { id: '44444444-4444-4444-8444-444444444444', pid: '33333333-3333-4333-8333-333333333333', display_name: '舟舟 · 示例四级账户' },
].map((user, index) => ({ ...user, invite_code: `TEST234${index}`, email: `preview${index}@example.invalid`, phone: null, status: index === 2 ? 'DISABLED' : 'ACTIVE', balance_fen: 35850, commission_available_fen: 25850, commission_frozen_fen: 10000, credit_balance: 1200, held_credits: 20, available_credits: 1180, created_at: '2026-09-04T08:00:00Z', last_login_at: null }));
function relations(id: string, level: number, page: number) {
  const user = testUsers.find(user => user.id === id)!;
  const direct = testUsers.filter(item => item.pid === id), indirect = testUsers.filter(item => direct.some(parent => parent.id === item.pid));
  const children = level === 1 ? direct : indirect;
  return { user, parent: testUsers.find(item => item.id === user.pid) || null, direct_count: direct.length, indirect_count: indirect.length, level, page, total: children.length, has_more: false, items: page === 1 ? children.map(item => ({ ...item, parent_id: item.pid, parent_display_name: testUsers.find(parent => parent.id === item.pid)?.display_name })) : [] };
}
let config = { enabled: false, direct_rate_bps: 1000, indirect_rate_bps: 500, minimum_withdrawal_fen: 10000, invitation_reward_credits: 20, invite_page_base_url: 'https://example.invalid/invite', windows_download_url: 'https://example.invalid/app.exe', macos_download_url: '', revision: 0 };
let status = 'PENDING';
const withdrawal = () => ({ id: '11111111-1111-4111-8111-111111111111', user_id: '22222222-2222-4222-8222-222222222222', amount_fen: 10000, status, created_at: '2026-09-04T08:20:00Z' });
export class ApiError extends Error { constructor(message: string, readonly status: number, readonly details: Record<string, unknown>) { super(message); } }
function log(text: string) { const element = document.querySelector('[data-test-status]'); if (element) element.textContent = text; }
export async function getReferralSummary() { return { ...summary }; }
export async function getReferralRecords(kind: string, page = 1) {
  return { page, has_more: false, items: page !== 1 ? [] : kind === 'commissions' ? [{ id: '33333333-3333-4333-8333-333333333333', beneficiary_id: '22222222-2222-4222-8222-222222222222', payment_order_id: '44444444-4444-4444-8444-444444444444', level: 1, amount_fen: 100, base_amount_fen: 1000, rate_bps: 1000, created_at: '2026-09-04T08:00:00Z' }] : kind === 'withdrawals' ? [withdrawal()] : [] };
}
export async function applyReferralWithdrawal(input: Record<string, unknown>) { log(`模拟提交提现 ${input.amount_fen} 分：没有真实申请或转账`); return { id: 'preview', status: 'PENDING' }; }
export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const body = options.body ? JSON.parse(String(options.body)) : {};
  if (path.startsWith('/admin/users?')) return testUsers.map(user => ({ ...user, ...Object.fromEntries(Object.entries(relations(user.id, 1, 1)).filter(([key]) => ['parent', 'direct_count', 'indirect_count'].includes(key))) })) as T;
  if (path.startsWith('/admin/users/') && path.includes('/relations')) { const url = new URL(path, 'http://preview.invalid'); return relations(path.split('/')[3]!, Number(url.searchParams.get('level') || 1), Number(url.searchParams.get('page') || 1)) as T; }
  if (path === '/admin/distribution/config') { if (options.method === 'PATCH') { config = { ...body, revision: config.revision + 1 }; log('模拟保存配置：未写入真实数据库'); } return { ...config } as T; }
  if (path.startsWith('/admin/distribution/records/')) return await getReferralRecords(path.split('/records/')[1]!.split('?')[0]!) as T;
  if (path.endsWith('/review')) { status = body.decision; log(`模拟审核：${status}`); return { status } as T; }
  if (path.endsWith('/claim')) { status = 'PROCESSING'; log('模拟领取任务：不自动转账'); return { status } as T; }
  if (path.endsWith('/release')) { status = 'APPROVED'; log('模拟释放未打款任务'); return { status } as T; }
  if (path.endsWith('/paid')) { status = 'PAID'; log('模拟登记打款：没有真实转账'); return { status } as T; }
  if (path.endsWith('/payee')) return { ...withdrawal(), can_confirm: status === 'PROCESSING', alipay_real_name: '测试用户（非真实收款人）', alipay_account: 'preview@example.invalid', alipay_qr_code: qr } as T;
  if (path.startsWith('/referrals/invitations/')) return { invite_code: 'TEST2345', windows_download_url: '', macos_download_url: '' } as T;
  if (path === '/auth/register/email/captcha') return { captcha_id: 'test-captcha', image_data_url: qr } as T;
  if (path === '/auth/register/email/captcha/verify') { log('模拟图形验证通过'); return { captcha_token: 'test-proof' } as T; }
  if (path === '/auth/register/email/code') { log('模拟发送：没有发送任何邮件'); return { retry_after_seconds: 60 } as T; }
  if (path === '/auth/register/email') { log(`模拟注册：绑定 ${body.invite_code}，无真实新账户`); return { access_token: 'test-token' } as T; }
  if (path === '/auth/logout') return {} as T;
  throw new Error(`Preview API not implemented: ${path}`);
}
