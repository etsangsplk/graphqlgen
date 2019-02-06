import * as os from 'os'
import * as prettier from 'prettier'

import { GenerateArgs, ModelMap, ContextDefinition } from '../../types'
import {
  GraphQLTypeField,
  GraphQLTypeObject,
  GraphQLInterfaceObject,
  GraphQLTypeDefinition,
  GraphQLUnionObject,
} from '../../source-helper'
import {
  renderDefaultResolvers,
  getContextName,
  getModelName,
  TypeToInputTypeAssociation,
  InputTypesMap,
  printFieldLikeType,
  getDistinctInputTypes,
  renderEnums,
  groupModelsNameByImportPath,
  InterfacesMap,
  UnionsMap,
  createInterfacesMap,
  createUnionsMap,
  union,
  resolverReturnType,
} from '../common'
import { TypeAliasDefinition } from '../../introspection/types'
import { upperFirst } from '../../utils'

export function format(code: string, options: prettier.Options = {}) {
  try {
    return prettier.format(code, {
      ...options,
      parser: 'typescript',
    })
  } catch (e) {
    console.log(
      `There is a syntax error in generated code, unformatted code printed, error: ${JSON.stringify(
        e,
      )}`,
    )
    return code
  }
}

export function generate(args: GenerateArgs): string {
  // TODO: Maybe move this to source helper
  const inputTypesMap: InputTypesMap = args.types
    .filter(type => type.type.isInput)
    .reduce((inputTypes, type) => {
      return {
        ...inputTypes,
        [`${type.name}`]: type,
      }
    }, {})

  // TODO: Type this
  const typeToInputTypeAssociation: TypeToInputTypeAssociation = args.types
    .filter(
      type =>
        type.type.isObject &&
        type.fields.filter(
          field => field.arguments.filter(arg => arg.type.isInput).length > 0,
        ).length > 0,
    )
    .reduce((types, type) => {
      return {
        ...types,
        [`${type.name}`]: [].concat(
          ...(type.fields.map(field =>
            field.arguments
              .filter(arg => arg.type.isInput)
              .map(arg => arg.type.name),
          ) as any),
        ),
      }
    }, {})

  const interfacesMap = createInterfacesMap(args.interfaces)
  const unionsMap = createUnionsMap(args.unions)
  const hasPolymorphicObjects =
    Object.keys(interfacesMap).length > 0 || Object.keys(unionsMap).length > 0

  return `\
  ${renderHeader(args, { hasPolymorphicObjects })}

  ${renderEnums(args)}

  ${renderNamespaces(
    args,
    interfacesMap,
    unionsMap,
    typeToInputTypeAssociation,
    inputTypesMap,
  )}

  ${renderResolvers(args)}

  `
}

type HeaderOptions = {
  hasPolymorphicObjects?: boolean
}

function renderHeader(
  args: GenerateArgs,
  { hasPolymorphicObjects = false }: HeaderOptions = {},
): string {
  const imports = hasPolymorphicObjects
    ? ['GraphQLResolveInfo', 'GraphQLIsTypeOfFn']
    : ['GraphQLResolveInfo']

  return `
// Code generated by github.com/prisma/graphqlgen, DO NOT EDIT.

import { ${imports.join(', ')} } from 'graphql'
${renderImports(args)}
  `
}

function renderImports(args: GenerateArgs) {
  const modelsToImport = Object.keys(args.modelMap)
    .filter(modelName => {
      const modelDef = args.modelMap[modelName].definition

      return !(
        modelDef.kind === 'TypeAliasDefinition' &&
        (modelDef as TypeAliasDefinition).isEnum
      )
    })
    .map(modelName => args.modelMap[modelName])
  const modelsByImportPaths = groupModelsNameByImportPath(modelsToImport)

  if (args.context) {
    const importsFromContextPath =
      modelsByImportPaths[args.context.contextPath] || []

    return importsToString(
      Object.assign({}, modelsByImportPaths, {
        [args.context.contextPath]: importsFromContextPath.concat(
          getContextName(args.context),
        ),
      }),
    )
  }

  return `${importsToString(modelsByImportPaths)}${os.EOL}type ${getContextName(
    args.context,
  )} = any`
}

function importsToString(
  modelsByImportPaths: ReturnType<typeof groupModelsNameByImportPath>,
) {
  return Object.keys(modelsByImportPaths)
    .map(
      importPath =>
        `import { ${modelsByImportPaths[importPath].join(
          ', ',
        )} } from '${importPath}'`,
    )
    .join(os.EOL)
}

function renderNamespaces(
  args: GenerateArgs,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
  typeToInputTypeAssociation: TypeToInputTypeAssociation,
  inputTypesMap: InputTypesMap,
): string {
  return `\
    ${renderObjectNamespaces(
      args,
      interfacesMap,
      unionsMap,
      typeToInputTypeAssociation,
      inputTypesMap,
    )}

    ${renderInterfaceNamespaces(args, interfacesMap, unionsMap)}

    ${renderUnionNamespaces(args)}
  `
}

function renderObjectNamespaces(
  args: GenerateArgs,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
  typeToInputTypeAssociation: TypeToInputTypeAssociation,
  inputTypesMap: InputTypesMap,
): string {
  return args.types
    .filter(type => type.type.isObject)
    .map(type =>
      renderNamespace(
        type,
        interfacesMap,
        unionsMap,
        typeToInputTypeAssociation,
        inputTypesMap,
        args,
      ),
    )
    .join(os.EOL)
}

function renderInterfaceNamespaces(
  args: GenerateArgs,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
): string {
  return args.interfaces
    .map(type => renderInterfaceNamespace(type, interfacesMap, unionsMap, args))
    .join(os.EOL)
}

function renderUnionNamespaces(args: GenerateArgs): string {
  return args.unions.map(type => renderUnionNamespace(type, args)).join(os.EOL)
}

function renderInterfaceNamespace(
  graphQLTypeObject: GraphQLInterfaceObject,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
  args: GenerateArgs,
): string {
  return `\
    export namespace ${graphQLTypeObject.name}Resolvers {
      ${renderInputArgInterfaces(
        graphQLTypeObject,
        args.modelMap,
        interfacesMap,
        unionsMap,
      )}

      export interface Type {
        __resolveType: ${renderTypeResolveTypeResolver(graphQLTypeObject, args)}
      }
    }
  `
}

export const renderTypeResolveTypeResolver = (
  abstractType: GraphQLInterfaceObject | GraphQLUnionObject,
  args: GenerateArgs,
): string => {
  const modelNames: string[] = []
  const gqlObjectNameTypes: string[] = []
  const gqlObjects =
    abstractType.kind === 'interface'
      ? abstractType.implementors
      : abstractType.types

  for (const gqlObj of gqlObjects) {
    modelNames.push(getModelName(gqlObj, args.modelMap))
    gqlObjectNameTypes.push(renderStringConstant(gqlObj.name))
  }

  return `
  (
    value: ${union(modelNames)},
    context: ${getContextName(args.context)},
    info: GraphQLResolveInfo
  ) => ${resolverReturnType(union(gqlObjectNameTypes))}
  `
}

const renderStringConstant = (x: unknown) => `"${x}"`

function renderUnionNamespace(
  graphQLTypeObject: GraphQLUnionObject,
  args: GenerateArgs,
): string {
  return `\
    export namespace ${graphQLTypeObject.name}Resolvers {
      export interface Type {
        __resolveType?: ${renderTypeResolveTypeResolver(
          graphQLTypeObject,
          args,
        )}
      }
    }
  `
}

function renderNamespace(
  graphQLTypeObject: GraphQLTypeObject,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
  typeToInputTypeAssociation: TypeToInputTypeAssociation,
  inputTypesMap: InputTypesMap,
  args: GenerateArgs,
): string {
  return `\
    export namespace ${graphQLTypeObject.name}Resolvers {

    ${
      args.defaultResolversEnabled
        ? renderDefaultResolvers(graphQLTypeObject, args, 'defaultResolvers')
        : ''
    }

    ${renderInputTypeInterfaces(
      graphQLTypeObject,
      args.modelMap,
      interfacesMap,
      unionsMap,
      typeToInputTypeAssociation,
      inputTypesMap,
    )}

    ${renderInputArgInterfaces(
      graphQLTypeObject,
      args.modelMap,
      interfacesMap,
      unionsMap,
    )}

    ${renderResolverFunctionInterfaces(
      graphQLTypeObject,
      args.modelMap,
      interfacesMap,
      unionsMap,
      args.context,
    )}

    ${renderResolverTypeInterface(
      graphQLTypeObject,
      args.modelMap,
      interfacesMap,
      unionsMap,
      args.context,
    )}

    ${/* TODO renderResolverClass(type, modelMap) */ ''}
  }
  `
}

function renderIsTypeOfFunctionInterface(
  type: GraphQLTypeObject | GraphQLInterfaceObject,
  modelMap: ModelMap,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
  context?: ContextDefinition,
) {
  let possibleTypes: GraphQLTypeDefinition[] = []

  // TODO Refactor once type is a proper discriminated union
  if (!type.type.isInterface) {
    type = type as GraphQLTypeObject
    if (type.implements) {
      possibleTypes = type.implements.reduce(
        (obj: GraphQLTypeDefinition[], interfaceName) => {
          return [...obj, ...interfacesMap[interfaceName]]
        },
        [],
      )
    }
  }

  for (let unionName in unionsMap) {
    if (unionsMap[unionName].find(unionType => unionType.name === type.name)) {
      possibleTypes = unionsMap[unionName]
    }
  }

  if (possibleTypes.length === 0) {
    return ''
  }
  return `\
    __isTypeOf?: GraphQLIsTypeOfFn<${possibleTypes
      .map(possibleType => getModelName(possibleType, modelMap))
      .join(' | ')}, ${getContextName(context)}>;`
}

function renderInputTypeInterfaces(
  type: GraphQLTypeObject,
  modelMap: ModelMap,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
  typeToInputTypeAssociation: TypeToInputTypeAssociation,
  inputTypesMap: InputTypesMap,
) {
  if (!typeToInputTypeAssociation[type.name]) {
    return ``
  }

  return getDistinctInputTypes(type, typeToInputTypeAssociation, inputTypesMap)
    .map(typeAssociation => {
      return `export interface ${inputTypesMap[typeAssociation].name} {
      ${inputTypesMap[typeAssociation].fields.map(field =>
        printFieldLikeType(field, modelMap, interfacesMap, unionsMap),
      )}
    }`
    })
    .join(os.EOL)
}

function renderInputArgInterfaces(
  type: GraphQLTypeObject | GraphQLInterfaceObject,
  modelMap: ModelMap,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
): string {
  return type.fields
    .map(field =>
      renderInputArgInterface(field, modelMap, interfacesMap, unionsMap),
    )
    .join(os.EOL)
}

function renderInputArgInterface(
  field: GraphQLTypeField,
  modelMap: ModelMap,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
): string {
  if (field.arguments.length === 0) {
    return ''
  }

  return `
  export interface Args${upperFirst(field.name)} {
    ${field.arguments
      .map(arg =>
        printFieldLikeType(
          arg as GraphQLTypeField,
          modelMap,
          interfacesMap,
          unionsMap,
        ),
      )
      .join(os.EOL)}
  }
  `
}

function renderResolverFunctionInterfaces(
  type: GraphQLTypeObject,
  modelMap: ModelMap,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
  context?: ContextDefinition,
): string {
  return type.fields
    .map(
      field =>
        `export type ${upperFirst(field.name)}Resolver = ${renderTypeResolver(
          field,
          type,
          modelMap,
          interfacesMap,
          unionsMap,
          context,
        )}`,
    )
    .join(os.EOL)
}

function renderResolverTypeInterface(
  type: GraphQLTypeObject | GraphQLInterfaceObject,
  modelMap: ModelMap,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
  context?: ContextDefinition,
  interfaceName: string = 'Type',
): string {
  return `
  export interface ${interfaceName} {
    ${type.fields
      .map(
        field =>
          `${field.name}: ${renderTypeResolver(
            field,
            type,
            modelMap,
            interfacesMap,
            unionsMap,
            context,
          )}`,
      )
      .join(os.EOL)}
      ${renderIsTypeOfFunctionInterface(
        type,
        modelMap,
        interfacesMap,
        unionsMap,
        context,
      )}
  }
  `
}

const renderTypeResolver = (
  field: GraphQLTypeField,
  type: GraphQLTypeObject | GraphQLInterfaceObject,
  modelMap: ModelMap,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
  context?: ContextDefinition,
): string => {
  let parent: string

  if (type.type.isInterface) {
    const implementingTypes = interfacesMap[type.name]

    parent = implementingTypes
      .map(implType => getModelName(implType, modelMap, 'undefined'))
      .join(' | ')
  } else {
    parent = getModelName(type.type as any, modelMap, 'undefined')
  }

  const params = `
  (
    parent: ${parent},
    args: ${
      field.arguments.length > 0 ? `Args${upperFirst(field.name)}` : '{}'
    },
    ctx: ${getContextName(context)},
    info: GraphQLResolveInfo,
  )
  `
  const returnType = printFieldLikeType(
    field,
    modelMap,
    interfacesMap,
    unionsMap,
    { isReturn: true },
  )

  if (type.name === 'Subscription') {
    return `
    {
      subscribe: ${params} => ${resolverReturnType(
      `AsyncIterator<${returnType}>`,
    )}
      resolve?: ${params} => ${resolverReturnType(returnType)}
    }
    `
  }

  const func = `${params} => ${resolverReturnType(returnType)}`

  const DelegatedParentResolver = `
    {
      fragment: string
      resolver: ${func}
    }
  `

  const resolver = union([`(${func})`, DelegatedParentResolver])

  return resolver
}

function renderResolvers(args: GenerateArgs): string {
  return `\
export interface Resolvers {
  ${[
    ...args.types
      .filter(obj => obj.type.isObject)
      .map(type => `${type.name}: ${type.name}Resolvers.Type`),
    ...args.interfaces.map(type => `${type.name}?: ${type.name}Resolvers.Type`),
    ...args.unions.map(type => `${type.name}?: ${type.name}Resolvers.Type`),
  ].join(os.EOL)}
}
  `
}