/**
 * Key sets LDtk 1.5.3 writes, taken from LDtk's own sample project ("Typical 2D platformer",
 * jsonVersion 1.5.3). Our generated project must contain every one of them so the editor opens it
 * without repair.
 */
export const LDTK_153_KEYS: Readonly<Record<string, readonly string[]>> = {
  project: [
    '__header__', 'appBuildId', 'backupLimit', 'backupOnSave', 'backupRelPath', 'bgColor', 'customCommands',
    'defaultEntityHeight', 'defaultEntityWidth', 'defaultGridSize', 'defaultLevelBgColor', 'defaultLevelHeight',
    'defaultLevelWidth', 'defaultPivotX', 'defaultPivotY', 'defs', 'dummyWorldIid', 'exportLevelBg', 'exportTiled',
    'externalLevels', 'flags', 'identifierStyle', 'iid', 'imageExportMode', 'jsonVersion', 'levelNamePattern', 'levels',
    'minifyJson', 'nextUid', 'pngFilePattern', 'simplifiedExport', 'toc', 'tutorialDesc', 'worldGridHeight',
    'worldGridWidth', 'worldLayout', 'worlds',
  ],
  header: ['app', 'appAuthor', 'appVersion', 'doc', 'fileType', 'schema', 'url'],
  defs: ['entities', 'enums', 'externalEnums', 'layers', 'levelFields', 'tilesets'],
  layerDef: [
    '__type', 'autoRuleGroups', 'autoSourceLayerDefUid', 'autoTilesKilledByOtherLayerUid', 'biomeFieldUid',
    'canSelectWhenInactive', 'displayOpacity', 'doc', 'excludedTags', 'gridSize', 'guideGridHei', 'guideGridWid',
    'hideFieldsWhenInactive', 'hideInList', 'identifier', 'inactiveOpacity', 'intGridValues', 'intGridValuesGroups',
    'parallaxFactorX', 'parallaxFactorY', 'parallaxScaling', 'pxOffsetX', 'pxOffsetY', 'renderInWorldView', 'requiredTags',
    'tilePivotX', 'tilePivotY', 'tilesetDefUid', 'type', 'uiColor', 'uiFilterTags', 'uid', 'useAsyncRender',
  ],
  intGridValue: ['color', 'groupUid', 'identifier', 'tile', 'value'],
  entityDef: [
    'allowOutOfBounds', 'color', 'doc', 'exportToToc', 'fieldDefs', 'fillOpacity', 'height', 'hollow', 'identifier',
    'keepAspectRatio', 'limitBehavior', 'limitScope', 'lineOpacity', 'maxCount', 'maxHeight', 'maxWidth', 'minHeight',
    'minWidth', 'nineSliceBorders', 'pivotX', 'pivotY', 'renderMode', 'resizableX', 'resizableY', 'showName', 'tags',
    'tileOpacity', 'tileRect', 'tileRenderMode', 'tilesetId', 'uiTileRect', 'uid', 'width',
  ],
  fieldDef: [
    '__type', 'acceptFileTypes', 'allowOutOfLevelRef', 'allowedRefTags', 'allowedRefs', 'allowedRefsEntityUid',
    'arrayMaxLength', 'arrayMinLength', 'autoChainRef', 'canBeNull', 'defaultOverride', 'doc', 'editorAlwaysShow',
    'editorCutLongValues', 'editorDisplayColor', 'editorDisplayMode', 'editorDisplayPos', 'editorDisplayScale',
    'editorLinkStyle', 'editorShowInWorld', 'editorTextPrefix', 'editorTextSuffix', 'exportToToc', 'identifier',
    'isArray', 'max', 'min', 'regex', 'searchable', 'symmetricalRef', 'textLanguageMode', 'tilesetUid', 'type', 'uid',
    'useForSmartColor',
  ],
  enumDef: ['externalFileChecksum', 'externalRelPath', 'iconTilesetUid', 'identifier', 'tags', 'uid', 'values'],
  enumValue: ['color', 'id', 'tileRect'],
  level: [
    '__bgColor', '__bgPos', '__neighbours', '__smartColor', 'bgColor', 'bgPivotX', 'bgPivotY', 'bgPos', 'bgRelPath',
    'externalRelPath', 'fieldInstances', 'identifier', 'iid', 'layerInstances', 'pxHei', 'pxWid', 'uid',
    'useAutoIdentifier', 'worldDepth', 'worldX', 'worldY',
  ],
  layerInstance: [
    '__cHei', '__cWid', '__gridSize', '__identifier', '__opacity', '__pxTotalOffsetX', '__pxTotalOffsetY',
    '__tilesetDefUid', '__tilesetRelPath', '__type', 'autoLayerTiles', 'entityInstances', 'gridTiles', 'iid', 'intGridCsv',
    'layerDefUid', 'levelId', 'optionalRules', 'overrideTilesetUid', 'pxOffsetX', 'pxOffsetY', 'seed', 'visible',
  ],
  entityInstance: [
    '__grid', '__identifier', '__pivot', '__smartColor', '__tags', '__tile', '__worldX', '__worldY', 'defUid',
    'fieldInstances', 'height', 'iid', 'px', 'width',
  ],
  fieldInstance: ['__identifier', '__tile', '__type', '__value', 'defUid', 'realEditorValues'],
};
