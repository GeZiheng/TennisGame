/**
 * 网球计分：分 → 局 → 盘。**一盘定胜负**。
 *
 * 这一层是纯状态机，不碰球、不碰场地、不读时钟。`Duel` 只在「这一分归谁」
 * 定下来之后调一次 `awardPoint()`，然后照着返回的 `PointOutcome` 决定是
 * 接着发球、换发球局、还是整盘结束。
 *
 * ## 规则（按 ITF 的正式规则，去掉「五盘三胜」这一类赛制差异）
 *
 * - **分**：0 / 15 / 30 / 40。40-40 是平分（deuce），之后必须**净胜两分**：
 *   领先一分是占先（AD），被追平又回平分。
 * - **局**：先到 4 分且净胜 2 分。每局结束**换发球方**。
 * - **盘**：先到 6 局且净胜 2 局。6-6 进**抢七**：先到 7 分且净胜 2 分。
 *   本作一盘定胜负，所以抢七的胜者直接赢下整盘。
 * - **发球区**：每一分都从「平分区（右区）/ 占先区（左区）」交替发球，
 *   由**这一局已经打了几分**的奇偶决定（偶数 = 右区）。抢七同理。
 * - **抢七的发球轮转**：先发的人发第 1 分，之后每人连发 2 分
 *   （1-2-2-2…），所以 `serveServer()` 不能直接读 `server`。
 *
 * ## 为什么用「原始分数」而不是 0/15/30/40 存
 *
 * 平分和占先是**相对关系**：40-40 之后领先一分显示 AD，被追平又显示 40。
 * 存绝对值（0..3）就不得不在每一处判断前后关系；存原始计数（0,1,2,3,4…）
 * 只在显示的时候换算一次，判定只做「>=4 且净胜 2」这一条，简单且不会漏分支。
 */

export type Side = 'player' | 'machine';

/** 发球区。`deuce` = 发球方的右半区，`ad` = 左半区。 */
export type ServeCourt = 'deuce' | 'ad';

export const otherSide = (s: Side): Side => (s === 'player' ? 'machine' : 'player');

/** 这一刻该谁发、从哪半边发。 */
export interface ServeInfo {
  server: Side;
  court: ServeCourt;
}

/** 一分打完之后发生了什么。`Duel` 靠它决定要不要播「换局 / 抢七 / 结束」。 */
export interface PointOutcome {
  winner: Side;
  gameWon: boolean;
  setWon: boolean;
  matchWon: boolean;
  tiebreakStarted: boolean;
}

/** 把原始分数换成记分牌上的字。 */
export function pointLabel(points: readonly number[], i: 0 | 1, tiebreak: boolean): string {
  const a = points[i];
  const b = points[1 - i];
  // 抢七直接显示数字——那里的 15/30/40 没有意义
  if (tiebreak) return String(a);
  if (a >= 3 && b >= 3) {
    if (a === b) return '40';
    return a > b ? 'AD' : '40';
  }
  return ['0', '15', '30', '40'][Math.min(a, 3)];
}

/** 平分：40-40 之后还没分出占先。HUD 用它显示「平分」。 */
export function isDeuce(points: readonly number[], tiebreak: boolean): boolean {
  return !tiebreak && points[0] >= 3 && points[0] === points[1];
}

/** 占先方。没有占先时返回 null。 */
export function advantageSide(points: readonly number[], tiebreak: boolean): Side | null {
  if (tiebreak || points[0] < 3 || points[1] < 3) return null;
  if (points[0] - points[1] === 1) return 'player';
  if (points[1] - points[0] === 1) return 'machine';
  return null;
}

export class TennisMatch {
  /** 本局（或本抢七）的原始分数 */
  points: [number, number] = [0, 0];
  /** 本盘的局数 */
  games: [number, number] = [0, 0];
  /** 盘数。一盘定胜负，所以结束时有且只有一方是 1。 */
  sets: [number, number] = [0, 0];
  /** 这一局（普通局）的发球方。抢七期间不用它，见 `serveServer()`。 */
  server: Side;
  tiebreak = false;
  over = false;
  winner: Side | null = null;

  /** 抢七第一个发球的人（= 原本该发下一局的人） */
  private tbFirstServer: Side = 'player';
  /** 抢七已经打了几分 */
  private tbPlayed = 0;

  constructor(server: Side = 'player') {
    this.server = server;
  }

  reset(server: Side = 'player') {
    this.points = [0, 0];
    this.games = [0, 0];
    this.sets = [0, 0];
    this.server = server;
    this.tiebreak = false;
    this.over = false;
    this.winner = null;
    this.tbFirstServer = server;
    this.tbPlayed = 0;
  }

  /** 这一分从哪半边发。偶数分 = 右区（deuce），奇数分 = 左区（ad）。 */
  serveCourt(): ServeCourt {
    if (this.tiebreak) return this.tbPlayed % 2 === 0 ? 'deuce' : 'ad';
    return (this.points[0] + this.points[1]) % 2 === 0 ? 'deuce' : 'ad';
  }

  /**
   * 这一刻的发球方。
   *
   * 普通局就是 `server`；抢七按 1-2-2 轮转——先发的打第 1 分，之后每人连发
   * 两分。所以这里不能返回 `server`：抢七中它一直停在「本该发下一局的人」，
   * 而实际发球的人每两分换一次。
   */
  serveServer(): Side {
    if (!this.tiebreak) return this.server;
    if (this.tbPlayed === 0) return this.tbFirstServer;
    const block = Math.floor((this.tbPlayed - 1) / 2);
    return block % 2 === 0 ? otherSide(this.tbFirstServer) : this.tbFirstServer;
  }

  serveInfo(): ServeInfo {
    return { server: this.serveServer(), court: this.serveCourt() };
  }

  /** 这一分归 `winner`。返回的 `PointOutcome` 只说「发生了什么」，不负责播报。 */
  awardPoint(winner: Side): PointOutcome {
    const out: PointOutcome = {
      winner,
      gameWon: false,
      setWon: false,
      matchWon: false,
      tiebreakStarted: false,
    };
    if (this.over) return out;

    const i = winner === 'player' ? 0 : 1;
    const j = 1 - i;
    this.points[i]++;

    /* ---- 抢七：先到 7 且净胜 2。赢下来就是整盘（一盘制） ---- */
    if (this.tiebreak) {
      this.tbPlayed++;
      if (this.points[i] >= 7 && this.points[i] - this.points[j] >= 2) {
        this.games[i]++;
        this.sets[i]++;
        this.tiebreak = false;
        this.over = true;
        this.winner = winner;
        out.gameWon = true;
        out.setWon = true;
        out.matchWon = true;
      }
      return out;
    }

    /* ---- 普通局：先到 4 且净胜 2 ---- */
    if (this.points[i] < 4 || this.points[i] - this.points[j] < 2) return out;

    this.games[i]++;
    this.points = [0, 0];
    out.gameWon = true;

    // 一盘：6 局且净胜 2 局
    if (this.games[i] >= 6 && this.games[i] - this.games[j] >= 2) {
      this.sets[i]++;
      this.over = true;
      this.winner = winner;
      out.setWon = true;
      out.matchWon = true;
      return out;
    }

    // 6-6 进抢七。先发的人是「下一局该发的人」，也就是刚发完这一局的人的对手。
    if (this.games[0] === 6 && this.games[1] === 6) {
      this.tiebreak = true;
      this.tbPlayed = 0;
      this.tbFirstServer = otherSide(this.server);
      out.tiebreakStarted = true;
      return out;
    }

    this.server = otherSide(this.server);
    return out;
  }
}
