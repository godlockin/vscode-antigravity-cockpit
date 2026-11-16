/**
 * Snapshot 组装器（纯函数层）：
 * 可见模型过滤 + 分组映射 + 配额签名多数派校验 + 未分组模型兜底。
 * 不触碰 configService / vscode / 网络，所有副作用通过返回值交给调用方执行。
 */

import { ModelQuotaInfo, QuotaGroup } from '../shared/types';


export interface SnapshotGroupingConfig {
    groupingEnabled: boolean;
    groupMappings: Record<string, string>;
    /** 以 modelId 为键的自定义名称（多数票决定组名） */
    groupingCustomNames: Record<string, string>;
    /** 用户自定义可见模型；空数组代表全部可见 */
    visibleModels: string[];
}

export interface SnapshotAssemblySideEffects {
    /** visibleModels 过滤后为空（配置与服务端模型不匹配），调用方应重置可见列表 */
    resetVisibleModels: boolean;
    /**
     * 组内配额签名与多数派不一致、不在分组视图中展示的 modelId。
     * 仅用于展示层过滤，调用方不得据此删除 config.groupMappings 中的条目——
     * 用户的分组配置只能由用户自己修改。
     */
    removedMappingIds: string[];
}

export interface SnapshotAssemblyResult extends SnapshotAssemblySideEffects {
    models: ModelQuotaInfo[];
    groups: QuotaGroup[] | undefined;
}

/** 找出组内配额签名（remainingFraction + resetTime）的多数派签名。 */
function majoritySignature(groupModels: ModelQuotaInfo[]): string {
    const signatureCount = new Map<string, number>();
    for (const model of groupModels) {
        const fraction = model.remainingFraction ?? 0;
        const signature = `${fraction.toFixed(6)}_${model.resetTime.getTime()}`;
        signatureCount.set(signature, (signatureCount.get(signature) ?? 0) + 1);
    }
    let majority = '';
    let maxCount = 0;
    for (const [sig, count] of signatureCount) {
        if (count > maxCount) {
            maxCount = count;
            majority = sig;
        }
    }
    return majority;
}

function resolveGroupName(
    groupModels: ModelQuotaInfo[],
    groupIndex: number,
    customNames: Record<string, string>,
): string {
    const nameVotes = new Map<string, number>();
    for (const model of groupModels) {
        const customName = customNames[model.modelId];
        if (customName) {
            nameVotes.set(customName, (nameVotes.get(customName) ?? 0) + 1);
        }
    }
    let groupName = '';
    let maxVotes = 0;
    for (const [name, votes] of nameVotes) {
        if (votes > maxVotes) {
            maxVotes = votes;
            groupName = name;
        }
    }
    if (groupName) {
        return groupName;
    }
    return groupModels.length === 1 ? groupModels[0].label : `Group ${groupIndex}`;
}

export function assembleSnapshotModels(
    inputModels: ModelQuotaInfo[],
    config: SnapshotGroupingConfig,
): SnapshotAssemblyResult {
    const models = [...inputModels];

    // 1) 可见模型过滤
    let resetVisibleModels = false;
    const visibleModels = config.visibleModels ?? [];
    if (visibleModels.length > 0) {
        const visibleSet = new Set(visibleModels);
        const filtered = models.filter(model => visibleSet.has(model.modelId));
        if (filtered.length === 0 && models.length > 0) {
            resetVisibleModels = true;
        } else {
            models.splice(0, models.length, ...filtered);
        }
    }

    let groups: QuotaGroup[] | undefined;
    const removedMappingIds: string[] = [];

    if (config.groupingEnabled) {
        const groupMap = new Map<string, ModelQuotaInfo[]>();
        const savedMappings = config.groupMappings;

        // 2) 按已存映射建组
        if (Object.keys(savedMappings).length > 0) {
            for (const model of models) {
                const groupId = savedMappings[model.modelId];
                if (groupId) {
                    const bucket = groupMap.get(groupId);
                    if (bucket) {
                        bucket.push(model);
                    } else {
                        groupMap.set(groupId, [model]);
                    }
                }
            }

            // 3) 多数派配额签名校验：不一致的模型不在分组视图中展示
            //    注意：这里只影响"展示"，绝不删除 config.groupMappings 中的条目。
            //    早期实现会同时删除映射，导致用户刚保存的分组被系统自动清空，
            //    表现为「无法调整分组里的模型」；用户配置必须由用户自己修改。
            for (const [, groupModels] of groupMap) {
                if (groupModels.length <= 1) {
                    continue;
                }
                const majority = majoritySignature(groupModels);
                for (const model of groupModels) {
                    const fraction = model.remainingFraction ?? 0;
                    const signature = `${fraction.toFixed(6)}_${model.resetTime.getTime()}`;
                    if (signature !== majority) {
                        removedMappingIds.push(model.modelId);
                    }
                }
            }

            if (removedMappingIds.length > 0) {
                const removalSet = new Set(removedMappingIds);
                for (const [, gModels] of groupMap) {
                    for (let i = gModels.length - 1; i >= 0; i--) {
                        if (removalSet.has(gModels[i].modelId)) {
                            gModels.splice(i, 1);
                        }
                    }
                }
                for (const [gid, gModels] of Array.from(groupMap.entries())) {
                    if (gModels.length === 0) {
                        groupMap.delete(gid);
                    }
                }
            }
        }

        // 4) 分组视图只展示 groupMappings 中已有的模型（与上游一致）。
        //    未映射模型不进入任何组：webview 的分组编辑弹框以 config.groupMappings
        //    为准重建分组，若快照里出现映射外的组或成员，用户打开弹框时该组/成员
        //    就会消失，表现为「无法调整分组里的模型」。
        //    新模型的可见性由「自动纳入 visibleModels」保证（见 reactor 的
        //    adoptNewlyDiscoveredModels），其分组归属交给用户在弹框中分配。

        // 5) 转 QuotaGroup
        groups = [];
        let groupIndex = 1;
        for (const [groupId, groupModels] of groupMap) {
            const minPercentage = Math.min(...groupModels.map(m => m.remainingPercentage ?? 0));
            const firstModel = groupModels[0];
            groups.push({
                groupId,
                groupName: resolveGroupName(groupModels, groupIndex, config.groupingCustomNames),
                models: groupModels,
                remainingPercentage: minPercentage,
                resetTime: firstModel.resetTime,
                resetTimeDisplay: firstModel.resetTimeDisplay,
                timeUntilResetFormatted: firstModel.timeUntilResetFormatted,
                isExhausted: groupModels.some(m => m.isExhausted),
            });
            groupIndex++;
        }

        // 组按组内模型在输入列表中的最小索引排序，保持相对顺序
        const modelIndexMap = new Map<string, number>();
        models.forEach((m, i) => modelIndexMap.set(m.modelId, i));
        groups.sort((a, b) => {
            const minIndexA = Math.min(...a.models.map(m => modelIndexMap.get(m.modelId) ?? 99999));
            const minIndexB = Math.min(...b.models.map(m => modelIndexMap.get(m.modelId) ?? 99999));
            return minIndexA - minIndexB;
        });
    }

    return { models, groups, resetVisibleModels, removedMappingIds };
}
