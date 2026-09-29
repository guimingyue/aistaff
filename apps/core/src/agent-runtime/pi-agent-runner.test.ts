import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compactionSettingsFromEnv } from './pi-agent-runner';

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
