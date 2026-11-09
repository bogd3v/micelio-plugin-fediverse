import { Button, Table, Tbody, Td, Th, Thead, Tr, Typography } from '@strapi/design-system'
import { useNotification, useRBAC } from '@strapi/strapi/admin'
import { Link as RouterLink } from 'react-router-dom'
import { useState } from 'react'

import { useMessages } from '../messages'
import { ActionRefused, usePost, useResource } from '../page-api'
import { failureTitle, type Failure } from '../page-state'
import { MANAGE_PERMISSION } from '../permissions'
import { problemMessageId } from '../state'
import { Section } from './Section'

const ARTICLE_PATH = '/content-manager/collection-types/api::article.article'

/** The deliveries Fedify gave up on, with the action that sends the last activity again. */
export function FailuresSection() {
  const { t, date } = useMessages()
  const { toggleNotification } = useNotification()
  const { allowedActions } = useRBAC({ manage: [MANAGE_PERMISSION] })
  const { resource, reload } = useResource<{ failures: Failure[] }>('/failures')
  const post = usePost()
  const [busy, setBusy] = useState<string | null>(null)

  async function retry(row: Failure) {
    setBusy(row.articleDocumentId)
    try {
      const result = await post<{ activity: string; queued: number }>(
        `/failures/${row.articleDocumentId}/retry`
      )
      toggleNotification({
        type: 'success',
        message: t('fediverse.page.failures.retried', {
          activity: result.activity,
          queued: result.queued,
        }),
      })
      reload()
    } catch (error) {
      toggleNotification({
        type: 'danger',
        message: t(problemMessageId(error instanceof ActionRefused ? error.code : undefined)),
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section title={t('fediverse.page.failures.title')} resource={resource} retry={reload}>
      {({ failures }) =>
        failures.length === 0 ? (
          <Typography textColor="neutral600">{t('fediverse.page.failures.empty')}</Typography>
        ) : (
          <Table colCount={6} rowCount={failures.length}>
            <Thead>
              <Tr>
                <Th>{t('fediverse.page.failures.article')}</Th>
                <Th>{t('fediverse.page.failures.activity')}</Th>
                <Th>{t('fediverse.page.failures.attempts')}</Th>
                <Th>{t('fediverse.page.failures.error')}</Th>
                <Th>{t('fediverse.page.failures.at')}</Th>
                <Th>
                  <span style={{ position: 'absolute', left: -10000 }}>
                    {t('fediverse.page.failures.retry')}
                  </span>
                </Th>
              </Tr>
            </Thead>
            <Tbody>
              {failures.map((row) => {
                const title = failureTitle(row)
                return (
                  <Tr key={row.articleDocumentId}>
                    <Td>
                      {'text' in title ? (
                        <RouterLink to={`${ARTICLE_PATH}/${row.articleDocumentId}`}>
                          {title.text}
                        </RouterLink>
                      ) : (
                        t(title.messageId)
                      )}
                    </Td>
                    <Td>{row.lastActivityType ?? '—'}</Td>
                    <Td>{row.attempts}</Td>
                    <Td>{row.lastError ?? '—'}</Td>
                    <Td>{row.lastActivityAt ? date(row.lastActivityAt) : '—'}</Td>
                    <Td>
                      <Button
                        variant="secondary"
                        size="S"
                        loading={busy === row.articleDocumentId}
                        disabled={!allowedActions.canManage}
                        onClick={() => retry(row)}
                      >
                        {t('fediverse.page.failures.retry')}
                      </Button>
                    </Td>
                  </Tr>
                )
              })}
            </Tbody>
          </Table>
        )
      }
    </Section>
  )
}
