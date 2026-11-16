import {
    addModelToGroup,
    buildGroupMappingsFromGroups,
    buildGroupsFromMappings,
    createCustomGroup,
    findUngroupedModels,
    isModelCompatibleWithGroup,
    removeModelFromGroup,
    resolveGroupSignature,
    type CustomGroup,
    type GroupingModel,
} from './grouping_logic';

const models: GroupingModel[] = [
    { modelId: 'gemini-4-pro-high', label: 'Gemini 4 Pro (High)', remainingPercentage: 77.68561, resetTimeDisplay: '2026-11-16 05:15' },
    { modelId: 'gemini-4-pro-low', label: 'Gemini 4 Pro (Low)', remainingPercentage: 77.685610000001, resetTimeDisplay: '2026-11-16 05:15' },
    { modelId: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)', remainingPercentage: 100, resetTimeDisplay: '2026-11-16 08:04' },
];

describe('createCustomGroup', () => {
    it('创建空分组并按现有组数命名', () => {
        const group = createCustomGroup([]);
        expect(group.modelIds).toEqual([]);
        expect(group.name).toBe('Group 1');

        const second = createCustomGroup([group]);
        expect(second.name).toBe('Group 2');
        expect(second.id).not.toBe(group.id);
    });
});

describe('addModelToGroup / removeModelFromGroup', () => {
    it('往组里加模型（不修改原对象）', () => {
        const group: CustomGroup = { id: 'g1', name: 'G1', modelIds: [] };
        const next = addModelToGroup(group, 'gemini-4-pro-high');
        expect(next.modelIds).toEqual(['gemini-4-pro-high']);
        expect(group.modelIds).toEqual([]);
    });

    it('重复添加同一模型不产生重复项', () => {
        const group: CustomGroup = { id: 'g1', name: 'G1', modelIds: ['A'] };
        expect(addModelToGroup(group, 'A').modelIds).toEqual(['A']);
    });

    it('从组里删模型（不修改原对象）', () => {
        const group: CustomGroup = { id: 'g1', name: 'G1', modelIds: ['A', 'B'] };
        const next = removeModelFromGroup(group, 'A');
        expect(next.modelIds).toEqual(['B']);
        expect(group.modelIds).toEqual(['A', 'B']);
    });
});

describe('findUngroupedModels', () => {
    it('返回尚未分配到任何组的模型', () => {
        const groups: CustomGroup[] = [{ id: 'g1', name: 'G1', modelIds: ['gemini-4-pro-high'] }];
        const ungrouped = findUngroupedModels(groups, models);
        expect(ungrouped.map(m => m.modelId)).toEqual(['gemini-4-pro-low', 'claude-opus-5-5-high']);
    });
});

describe('resolveGroupSignature', () => {
    it('空组无签名', () => {
        expect(resolveGroupSignature({ id: 'g', name: 'G', modelIds: [] }, models)).toBeNull();
    });

    it('以组内首个模型为签名', () => {
        const group: CustomGroup = { id: 'g', name: 'G', modelIds: ['gemini-4-pro-high', 'x'] };
        expect(resolveGroupSignature(group, models)?.remainingPercentage).toBeCloseTo(77.68561, 5);
    });
});

describe('isModelCompatibleWithGroup', () => {
    const signature = { remainingPercentage: 77.68561, resetTimeDisplay: '2026-11-16 05:15' };

    it('无签名时一律兼容（新建空组可加任意模型）', () => {
        expect(isModelCompatibleWithGroup(models[2], null).isCompatible).toBe(true);
    });

    it('浮点尾数差异仍判为兼容（0.5pp 容差）', () => {
        expect(isModelCompatibleWithGroup(models[1], signature).isCompatible).toBe(true);
    });

    it('配额明显不同判为不兼容', () => {
        const result = isModelCompatibleWithGroup(models[2], signature);
        expect(result.isCompatible).toBe(false);
        expect(result.reason).toBe('quotaMismatch');
    });

    it('重置时间不同判为不兼容', () => {
        const result = isModelCompatibleWithGroup(
            { modelId: 'X', remainingPercentage: 77.68561, resetTimeDisplay: '2026-11-17 05:15' },
            signature,
        );
        expect(result.isCompatible).toBe(false);
        expect(result.reason).toBe('resetMismatch');
    });
});

describe('buildGroupMappingsFromGroups', () => {
    it('组内成员共享稳定 groupId，组名写入 groupNames', () => {
        const groups: CustomGroup[] = [
            { id: 'g1', name: 'My Pro', modelIds: ['gemini-4-pro-low', 'gemini-4-pro-high'] },
            { id: 'g2', name: 'My Claude', modelIds: ['claude-opus-5-5-high'] },
        ];
        const { groupMappings, groupNames } = buildGroupMappingsFromGroups(groups);
        expect(groupMappings).toEqual({
            'gemini-4-pro-high': 'gemini-4-pro-high_gemini-4-pro-low',
            'gemini-4-pro-low': 'gemini-4-pro-high_gemini-4-pro-low',
            'claude-opus-5-5-high': 'claude-opus-5-5-high',
        });
        expect(groupNames['gemini-4-pro-high']).toBe('My Pro');
        expect(groupNames['claude-opus-5-5-high']).toBe('My Claude');
    });

    it('空分组被丢弃', () => {
        const { groupMappings } = buildGroupMappingsFromGroups([
            { id: 'g1', name: 'Empty', modelIds: [] },
            { id: 'g2', name: 'Full', modelIds: ['gemini-4-pro-high'] },
        ]);
        expect(Object.keys(groupMappings)).toEqual(['gemini-4-pro-high']);
    });

    it('不原地排序入参（不改写用户数据顺序）', () => {
        const modelIds = ['gemini-4-pro-low', 'gemini-4-pro-high'];
        const groups: CustomGroup[] = [{ id: 'g', name: 'G', modelIds }];
        buildGroupMappingsFromGroups(groups);
        expect(modelIds).toEqual(['gemini-4-pro-low', 'gemini-4-pro-high']);
    });
});

describe('buildGroupsFromMappings', () => {
    it('按 groupMappings 重建分组，组名取自 groupNames 锚点', () => {
        const groups = buildGroupsFromMappings(
            {
                'gemini-4-pro-high': 'g1',
                'gemini-4-pro-low': 'g1',
                'claude-opus-5-5-high': 'g2',
            },
            models,
            { 'gemini-4-pro-high': 'Pro Group', 'claude-opus-5-5-high': 'Claude Group' },
        );
        expect(groups).toHaveLength(2);
        expect(groups[0].id).toBe('g1');
        expect(groups[0].name).toBe('Pro Group');
        expect(groups[0].modelIds).toEqual(['gemini-4-pro-high', 'gemini-4-pro-low']);
        expect(groups[1].name).toBe('Claude Group');
    });

    it('无名称映射时回退为 Group N', () => {
        const groups = buildGroupsFromMappings({ 'gemini-4-pro-high': 'g1' }, models);
        expect(groups[0].name).toBe('Group 1');
    });

    it('映射中不存在于模型清单的条目被忽略（与弹框渲染一致）', () => {
        const groups = buildGroupsFromMappings(
            { ghost: 'g1', 'gemini-4-pro-high': 'g2' },
            models,
        );
        expect(groups.map(g => g.id)).toEqual(['g2']);
    });
});

describe('端到端：建组 → 加模型 → 保存 → 重建', () => {
    it('用户自主创建的分组能被保存并重新打开', () => {
        // 1. 用户新建一个组
        let groups: CustomGroup[] = [createCustomGroup([])];
        expect(groups[0].modelIds).toEqual([]);

        // 2. 往组里加两个模型（配额不同也允许）
        groups[0] = addModelToGroup(groups[0], 'gemini-4-pro-high');
        groups[0] = addModelToGroup(groups[0], 'claude-opus-5-5-high');
        groups[0] = { ...groups[0], name: 'My Mixed Group' };

        // 3. 保存
        const { groupMappings, groupNames } = buildGroupMappingsFromGroups(groups);
        expect(Object.keys(groupMappings).sort()).toEqual(['claude-opus-5-5-high', 'gemini-4-pro-high']);
        expect(groupNames['gemini-4-pro-high']).toBe('My Mixed Group');

        // 4. 重新打开弹框：组与成员都还在
        const reopened = buildGroupsFromMappings(groupMappings, models, groupNames);
        expect(reopened).toHaveLength(1);
        expect(reopened[0].name).toBe('My Mixed Group');
        expect(reopened[0].modelIds.sort()).toEqual(['claude-opus-5-5-high', 'gemini-4-pro-high']);
    });
});
