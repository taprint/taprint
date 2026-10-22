// SPDX-License-Identifier: Apache-2.0
// validate_template 工具：schema 校验（包内 schema 资产按 schemaVersion 选取）
// + 内核业务规则校验（表达式文法/字段绑定/DSL 2.0 跨字段形状）
// + 宿主函数静态审计（最小版 ExpressionAudit，ADR-0007）。
import { DslValidator, type TemplateDSL } from 'taprint';
import { loadSchema, SCHEMA_VERSIONS } from '../lib/assets.ts';
import { auditHostFunctions } from '../lib/expression-audit.ts';

export interface ValidateTemplateInput {
  template: Record<string, unknown>;
  /** 已注册宿主函数名单（表达式 call 白名单；缺省为空 = 任何 call 都会报未注册）。 */
  hostFunctions?: string[];
}

export interface ValidateTemplateError {
  path: string;
  code: string;
  message: string;
}

export interface ValidateTemplateOutput {
  valid: boolean;
  errors: ValidateTemplateError[];
}

export function validateTemplate(input: ValidateTemplateInput): ValidateTemplateOutput {
  const dsl = input.template as TemplateDSL;
  const version = (dsl as Record<string, unknown>)?.schemaVersion;
  if (typeof version !== 'string' || !(SCHEMA_VERSIONS as readonly string[]).includes(version)) {
    return {
      valid: false,
      errors: [
        {
          path: '$.schemaVersion',
          code: 'unsupported-schema-version',
          message: `schemaVersion "${String(version)}" 不在支持列表（${SCHEMA_VERSIONS.join(' / ')}）；0.9 旧模板请先用内核 DslMigrator 迁移到 1.0`,
        },
      ],
    };
  }

  const schemaErrors = DslValidator.validate(dsl, loadSchema(version)).errors;
  const businessErrors = DslValidator.validateBusiness(dsl).errors;
  const auditErrors = auditHostFunctions(dsl, input.hostFunctions ?? []);

  const errors = [...schemaErrors, ...businessErrors, ...auditErrors];
  return { valid: errors.length === 0, errors };
}
