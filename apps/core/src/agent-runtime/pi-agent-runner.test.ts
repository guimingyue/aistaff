import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compactionSettingsFromEnv,
  modelAcceptsImages,
  shouldRegisterOrgTools,
} from './pi-agent-runner';

describe('会话压缩配置（env 驱动）', () => {
  it('缺省开启，并沿用 pi 内置阈值', () => {
    assert.deepEqual(compactionSettingsFromEnv({}), {
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
    });
  });

  it('只有 AISTAFF_AGENT_COMPACTION=0 才关闭', () => {
    assert.equal(compactionSettingsFromEnv({ AISTAFF_AGENT_COMPACTION: '0' }).enabled, false);
    assert.equal(compactionSettingsFromEnv({ AISTAFF_AGENT_COMPACTION: '1' }).enabled, true);
    assert.equal(compactionSettingsFromEnv({ AISTAFF_AGENT_COMPACTION: '' }).enabled, true);
  });

  it('阈值可调，且非法值回落默认而不是把压缩关掉', () => {
    assert.deepEqual(
      compactionSettingsFromEnv({
        AISTAFF_AGENT_COMPACTION_RESERVE_TOKENS: '4096',
        AISTAFF_AGENT_COMPACTION_KEEP_TOKENS: '8192',
      }),
      { enabled: true, reserveTokens: 4_096, keepRecentTokens: 8_192 },
    );
    for (const bad of ['', 'abc', 'NaN', '0', '-1', '1.5', 'Infinity']) {
      assert.equal(
        compactionSettingsFromEnv({ AISTAFF_AGENT_COMPACTION_RESERVE_TOKENS: bad }).reserveTokens,
        16_384,
        `非法值 ${JSON.stringify(bad)} 应回落默认`,
      );
    }
  });
});

describe('组织侧工具的注册闸门', () => {
  const cliEnv = { HOME: '/tmp/aistaff-profile' } as NodeJS.ProcessEnv;

  it('显式声明非空白名单且绑定校验通过才注册', () => {
    assert.equal(shouldRegisterOrgTools({ cliEnv, tools: ['dws_doc_read'] }), true);
  });

  it('默认档与空白名单都不注册：外部副作用面必须逐个点名开启', () => {
    assert.equal(shouldRegisterOrgTools({ cliEnv }), false);
    assert.equal(shouldRegisterOrgTools({ cliEnv, tools: [] }), false);
  });

  it('账号未绑定时即使点名了工具也不注册', () => {
    assert.equal(shouldRegisterOrgTools({ tools: ['dws_doc_read'] }), false);
  });
});

describe('入站图片的模型准入门禁', () => {
  it('只有声明 image 输入的模型才收图片', () => {
    assert.equal(modelAcceptsImages({ input: ['text', 'image'] }), true);
    assert.equal(modelAcceptsImages({ input: ['text'] }), false);
    assert.equal(modelAcceptsImages({ input: [] }), false);
  });

  it('模型未知或未声明输入时按不收处理，宁可拒绝也不静默丢图', () => {
    assert.equal(modelAcceptsImages({}), false);
    assert.equal(modelAcceptsImages(undefined), false);
  });
});
