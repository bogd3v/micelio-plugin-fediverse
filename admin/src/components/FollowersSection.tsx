import { Badge, Button, Table, Tbody, Td, Th, Thead, Tr, Typography } from '@strapi/design-system'
import { useNotification, useRBAC } from '@strapi/strapi/admin'
import { useState } from 'react'

import { useMessages } from '../messages'
import { ActionRefused, usePost, useResource } from '../page-api'
import { followerLabel, followerStatus, type Follower } from '../page-state'
import { problemMessageId } from '../state'
import { MANAGE_PERMISSION } from '../permissions'
import { Section } from './Section'

/** The followers, with the action that blocks or unblocks each one. */
export function FollowersSection() {
  const { t, date } = useMessages()
  const { toggleNotification } = useNotification()
  const { allowedActions } = useRBAC({ manage: [MANAGE_PERMISSION] })
  const { resource, reload } = useResource<{ followers: Follower[] }>('/followers')
  const post = usePost()
  const [busy, setBusy] = useState<string | null>(null)

  async function toggle(row: Follower) {
    setBusy(row.documentId)
    try {
      await post(`/followers/${row.documentId}/${row.blocked ? 'unblock' : 'block'}`)
      toggleNotification({
        type: 'success',
        message: t(
          row.blocked
            ? 'fediverse.page.followers.unblockedDone'
            : 'fediverse.page.followers.blockedDone'
        ),
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
    <Section title={t('fediverse.page.followers.title')} resource={resource} retry={reload}>
      {({ followers }) =>
        followers.length === 0 ? (
          <Typography textColor="neutral600">{t('fediverse.page.followers.empty')}</Typography>
        ) : (
          <Table colCount={5} rowCount={followers.length}>
            <Thead>
              <Tr>
                <Th>{t('fediverse.page.followers.handle')}</Th>
                <Th>{t('fediverse.page.followers.name')}</Th>
                <Th>{t('fediverse.page.followers.since')}</Th>
                <Th>{t('fediverse.page.followers.status')}</Th>
                <Th>
                  <span style={{ position: 'absolute', left: -10000 }}>
                    {t('fediverse.page.followers.block')}
                  </span>
                </Th>
              </Tr>
            </Thead>
            <Tbody>
              {followers.map((row) => {
                const status = followerStatus(row)
                return (
                  <Tr key={row.documentId}>
                    <Td>{followerLabel(row)}</Td>
                    <Td>{row.name ?? '—'}</Td>
                    <Td>{date(row.since)}</Td>
                    <Td>
                      <Badge
                        backgroundColor={status === 'blocked' ? 'danger100' : undefined}
                        textColor={status === 'blocked' ? 'danger700' : undefined}
                      >
                        {t(`fediverse.page.followers.${status}`)}
                      </Badge>
                    </Td>
                    <Td>
                      <Button
                        variant="secondary"
                        size="S"
                        loading={busy === row.documentId}
                        disabled={!allowedActions.canManage}
                        onClick={() => toggle(row)}
                      >
                        {t(
                          row.blocked
                            ? 'fediverse.page.followers.unblock'
                            : 'fediverse.page.followers.block'
                        )}
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
