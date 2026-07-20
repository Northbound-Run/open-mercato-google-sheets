import type { EntityWriter, NormalizedRecord, SyncScope } from './types'
import { createCommandBusWriter, pickField, splitFields } from './command-bus-writer'

// Bundled worked example: a writer for `customers.person`, built on the generic
// command-bus writer. It shows the pattern downstream teams follow for their own entities:
// map the normalized record to the module's create/update command input. Field resolution
// is tolerant of common header slugs (first_name / firstName / etc.) so a zero-config
// import from a typical contacts sheet works out of the box.

const CUSTOMERS_PERSON_ENTITY_TYPE = 'customers.person'

type DerivedNames = { firstName: string; lastName: string; displayName: string }

function deriveNames(base: Record<string, unknown>): DerivedNames | null {
  const firstName = pickField(base, ['first_name', 'firstname', 'first', 'given_name'])
  const lastName = pickField(base, ['last_name', 'lastname', 'last', 'surname', 'family_name'])
  const displayName = pickField(base, ['display_name', 'displayname', 'name', 'full_name'])

  if (firstName && lastName) {
    return { firstName, lastName, displayName: displayName ?? `${firstName} ${lastName}`.trim() }
  }
  if (displayName) {
    const parts = displayName.split(/\s+/).filter((p) => p.length > 0)
    if (parts.length >= 2) {
      return {
        firstName: firstName ?? parts.slice(0, -1).join(' '),
        lastName: lastName ?? (parts.at(-1) as string),
        displayName,
      }
    }
    return { firstName: firstName ?? displayName, lastName: lastName ?? displayName, displayName }
  }
  return null
}

function optionalPersonFields(base: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const email = pickField(base, ['email', 'primary_email', 'e_mail', 'email_address'])
  const phone = pickField(base, ['phone', 'primary_phone', 'telephone', 'mobile', 'phone_number'])
  const jobTitle = pickField(base, ['job_title', 'title', 'position'])
  const status = pickField(base, ['status'])
  const source = pickField(base, ['source'])
  const description = pickField(base, ['description', 'notes'])
  if (email) out.primaryEmail = email.toLowerCase()
  if (phone) out.primaryPhone = phone
  if (jobTitle) out.jobTitle = jobTitle
  if (status) out.status = status
  if (source) out.source = source
  if (description) out.description = description
  return out
}

function buildCreateInput(record: NormalizedRecord, scope: SyncScope): Record<string, unknown> {
  const { base, customFields } = splitFields(record.fields)
  const names = deriveNames(base)
  if (!names) {
    throw new Error('Row is missing a usable person name (need first+last name or a display name).')
  }
  return {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    firstName: names.firstName,
    lastName: names.lastName,
    displayName: names.displayName,
    ...optionalPersonFields(base),
    ...(Object.keys(customFields).length > 0 ? { customFields } : {}),
  }
}

function buildUpdateInput(localId: string, record: NormalizedRecord, _scope: SyncScope): Record<string, unknown> {
  const { base, customFields } = splitFields(record.fields)
  const names = deriveNames(base)
  return {
    id: localId,
    ...(names ? { firstName: names.firstName, lastName: names.lastName, displayName: names.displayName } : {}),
    ...optionalPersonFields(base),
    ...(Object.keys(customFields).length > 0 ? { customFields } : {}),
  }
}

export const customersPersonWriter: EntityWriter = createCommandBusWriter({
  entityType: CUSTOMERS_PERSON_ENTITY_TYPE,
  createCommand: 'customers.people.create',
  updateCommand: 'customers.people.update',
  buildCreateInput,
  buildUpdateInput,
  // customers.people.create returns { result: { entityId, personId } }; entityId is the
  // customer_entity local id we map the external id to. The default extractor reads it.
})

export default customersPersonWriter
