/**
 * 分组编辑的纯逻辑层（webview 与测试共用）。
 *
 * 分组编辑弹框的所有状态变更都收敛到此处，便于脱离 DOM 单测：
 * 建组、删组、改名、往组里加模型、从组里删模型、保存为 groupMappings，
 * 以及"模型与组的配额是否兼容"的判定。
 */

export interface GroupingModel {
    modelId: string;
    label?: string;
    remainingPercentage?: number;
    resetTimeDisplay?: string;
}

export interface CustomGroup {
    id: string;
    name: string;
    modelIds: string[];
}

export interface GroupSignature {
    remainingPercentage?: number;
    resetTimeDisplay?: string;
}

/** 配额百分比比较容差（百分点）：避免浮点尾数差异把整组判为不兼容 */
export const QUOTA_TOLERANCE_PCT = 0.5;

/**
 * 判断某模型能否加入指定组（配额一致才算同池）。
 * 仅作提示与排序依据，不阻止用户添加。
 */
export function isModelCompatibleWithGroup(
    model: GroupingModel,
    groupSignature: GroupSignature | null,
): { isCompatible: boolean; reason: 'quotaMismatch' | 'resetMismatch' | '' } {
    if (!groupSignature) {
        return { isCompatible: true, reason: '' };
    }
    const modelPct = typeof model.remainingPercentage === 'number' ? model.remainingPercentage : null;
    const groupPct = typeof groupSignature.remainingPercentage === 'number'
        ? groupSignature.remainingPercentage
        : null;
    if (modelPct !== null && groupPct !== null && Math.abs(modelPct - groupPct) > QUOTA_TOLERANCE_PCT) {
        return { isCompatible: false, reason: 'quotaMismatch' };
    }
    if (
        model.resetTimeDisplay
        && groupSignature.resetTimeDisplay
        && model.resetTimeDisplay !== groupSignature.resetTimeDisplay
    ) {
        return { isCompatible: false, reason: 'resetMismatch' };
    }
    return { isCompatible: true, reason: '' };
}

/** 取组的配额签名（以组内第一个模型为准） */
export function resolveGroupSignature(
    group: CustomGroup,
    allModels: ReadonlyArray<GroupingModel>,
): GroupSignature | null {
    if (!group.modelIds.length) {
        return null;
    }
    const first = allModels.find(m => m.modelId === group.modelIds[0]);
    if (!first) {
        return null;
    }
    return {
        remainingPercentage: first.remainingPercentage,
        resetTimeDisplay: first.resetTimeDisplay,
    };
}

/**
 * 新建一个空分组。
 * groupId 必须唯一：Date.now() 毫秒精度下连续建两个组会碰撞，
 * 用单调递增后缀保证不重复（否则第二个组会覆盖第一个，表现为"新建的组消失"）。
 */
export function createCustomGroup(existingGroups: ReadonlyArray<CustomGroup>): CustomGroup {
    const base = `custom_group_${Date.now()}`;
    let id = base;
    let suffix = 1;
    const taken = new Set(existingGroups.map(g => g.id));
    while (taken.has(id)) {
        id = `${base}_${suffix}`;
        suffix++;
    }
    return {
        id,
        name: `Group ${existingGroups.length + 1}`,
        modelIds: [],
    };
}

/** 从分组中移除一个模型（返回新数组，不修改入参） */
export function removeModelFromGroup(group: CustomGroup, modelId: string): CustomGroup {
    return {
        ...group,
        modelIds: group.modelIds.filter(id => id !== modelId),
    };
}

/** 把模型加入分组（返回新数组，不修改入参） */
export function addModelToGroup(group: CustomGroup, modelId: string): CustomGroup {
    if (group.modelIds.includes(modelId)) {
        return group;
    }
    return { ...group, modelIds: [...group.modelIds, modelId] };
}

/** 尚未分配到任何组的模型 */
export function findUngroupedModels(
    groups: ReadonlyArray<CustomGroup>,
    allModels: ReadonlyArray<GroupingModel>,
): GroupingModel[] {
    const grouped = new Set<string>();
    groups.forEach(g => g.modelIds.forEach(id => grouped.add(id)));
    return allModels.filter(m => !grouped.has(m.modelId));
}

/**
 * 把分组状态保存为 groupMappings / groupNames。
 * 空分组会被丢弃；groupId 由成员 modelId 排序拼接而成（稳定）。
 */
export function buildGroupMappingsFromGroups(groups: ReadonlyArray<CustomGroup>): {
    groupMappings: Record<string, string>;
    groupNames: Record<string, string>;
} {
    const groupMappings: Record<string, string> = {};
    const groupNames: Record<string, string> = {};

    for (const group of groups) {
        if (group.modelIds.length === 0) {
            continue;
        }
        const stableGroupId = [...group.modelIds].sort().join('_');
        for (const modelId of group.modelIds) {
            groupMappings[modelId] = stableGroupId;
            groupNames[modelId] = group.name;
        }
    }

    return { groupMappings, groupNames };
}

/**
 * 由已有的 groupMappings 重建分组列表（弹框打开时使用）。
 * 保持 groupMappings 中的原始顺序，避免用户保存后组顺序跳动。
 */
export function buildGroupsFromMappings(
    groupMappings: Record<string, string>,
    allModels: ReadonlyArray<GroupingModel>,
    groupNames?: Record<string, string>,
): CustomGroup[] {
    const groupOrder: string[] = [];
    const buckets = new Map<string, string[]>();

    for (const model of allModels) {
        const groupId = groupMappings[model.modelId];
        if (!groupId) {
            continue;
        }
        if (!buckets.has(groupId)) {
            buckets.set(groupId, []);
            groupOrder.push(groupId);
        }
        buckets.get(groupId)!.push(model.modelId);
    }

    return groupOrder.map((groupId, index) => {
        const modelIds = buckets.get(groupId)!;
        const anchorName = modelIds
            .map(id => groupNames?.[id])
            .find(name => typeof name === 'string' && name.length > 0);
        return {
            id: groupId,
            name: anchorName || `Group ${index + 1}`,
            modelIds,
        };
    });
}
