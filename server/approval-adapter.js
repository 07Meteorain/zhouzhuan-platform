'use strict';
/**
 * ApprovalAdapter —— 审批流转适配器（预留学校 OA 工作流接入）
 *
 * 业务代码只依赖 pushTodo() / onResult()，不关心待办在 OA 里还是平台里。
 * OA 工作流接口到位后：把 MODE 改成 'oa'，实现 OaApproval 即可。
 */
const { db, now } = require('./db');

const MODE = process.env.APPROVAL_MODE || 'local'; // local | oa

const OA_CONFIG = {
  workflowCreateUrl: process.env.OA_WORKFLOW_CREATE_URL || '',
  workflowQueryUrl: process.env.OA_WORKFLOW_QUERY_URL || '',
  callbackUrl: process.env.OA_WORKFLOW_CALLBACK_URL || '',
  appKey: process.env.OA_APP_KEY || '',
  appSecret: process.env.OA_APP_SECRET || '',
};

/** 本地实现：待办直接进平台内审批中心 */
const LocalApproval = {
  name: 'local',
  async pushTodo(req, approver) {
    // 平台内审批中心：待办即"状态为待审批的单据"，由列表页呈现
    return { extId: null, todoId: null, provider: 'local' };
  },
  async onResult(req, result, operator) {
    return { synced: true, provider: 'local' };
  },
  /** 本地模式下无需对账 */
  async reconcile() {
    return { checked: 0, fixed: 0, note: '本地审批模式无需对账' };
  },
};

/**
 * OaApproval —— OA 工作流实现（待接入）
 *
 * 接入步骤：
 *  1. 确认 OA 是否支持"外部系统触发工作流"（很多高校 OA 不开放，需走备选方案）
 *  2. 确认审批完成后 OA 能否回调本服务
 *  3. 填入 OA_CONFIG，实现 createTodo() / queryStatus()
 *  4. 在 server/index.js 中把 APPROVAL_MODE 切到 'oa'
 *
 * 若 OA 不支持外部触发工作流，退化方案：
 *  - 审批仍在平台内完成（等同 LocalApproval）
 *  - 仅使用 OA 的"待办消息提醒"能力，通知老师有单待处理
 *  - 体验降级但主线闭环完整
 */
const OaApproval = {
  name: 'oa',
  config: OA_CONFIG,
  async pushTodo(req, approver) {
    if (!OA_CONFIG.workflowCreateUrl) {
      throw new Error('OA 工作流接入配置未完成：缺少 OA_WORKFLOW_CREATE_URL');
    }
    // TODO: 按 OA 文档实现"创建待办"，返回 OA 侧的流程实例 ID
    // const res = await fetch(OA_CONFIG.workflowCreateUrl, { ... });
    // return { extId: res.data.processId, provider: 'oa' };
    return { extId: null, todoId: null, provider: 'oa' };
  },
  async onResult(req, result, operator) {
    // TODO: 收到 OA 回调后更新本地状态；若回调丢失，由 reconcile() 兜底
    return { synced: true, provider: 'oa' };
  },
  /** 定时对账：拉取 OA 侧真实状态，补齐丢失的回调 */
  async reconcile() {
    // TODO: 遍历处于中间态的单据，调用 OA 查询接口核对状态并修正
    return { checked: 0, fixed: 0 };
  },
};

const current = MODE === 'oa' ? OaApproval : LocalApproval;

module.exports = { current, LocalApproval, OaApproval, MODE, OA_CONFIG };
