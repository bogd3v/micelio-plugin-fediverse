import { Badge, Box, Button, Flex, Typography } from '@strapi/design-system'
import { useNotification } from '@strapi/strapi/admin'
import type { PanelComponent } from '@strapi/content-manager/strapi-admin'
import { useState, type ReactNode } from 'react'

import { FederateRefused, useArticleFederation } from '../api'
import {
  blockedMessageId,
  federateHintId,
  problemMessageId,
  statusView,
  type ArticleFederation,
} from '../state'
import { useMessages } from '../messages'

const ARTICLE_UID = 'api::article.article'
const TITLE_ID = 'fediverse.panel.title'
const COUNTS = [
  ['likes', 'fediverse.panel.counts.likes'],
  ['boosts', 'fediverse.panel.counts.boosts'],
  ['repliesApproved', 'fediverse.panel.counts.repliesApproved'],
  ['repliesPending', 'fediverse.panel.counts.repliesPending'],
] as const

function Counts({ federation }: { federation: ArticleFederation }) {
  const { t } = useMessages()
  return (
    <Flex direction="column" alignItems="stretch" gap={1}>
      {COUNTS.map(([key, id]) => (
        <Flex key={key} justifyContent="space-between">
          <Typography variant="pi" textColor="neutral600">
            {t(id)}
          </Typography>
          <Typography variant="pi" fontWeight="bold">
            {federation.counts[key]}
          </Typography>
        </Flex>
      ))}
    </Flex>
  )
}

function Ready({
  federation,
  federate,
  refresh,
}: {
  federation: ArticleFederation
  federate: () => Promise<{ activity: string; queued: number; skipped: number }>
  refresh: () => void
}) {
  const { t, date } = useMessages()
  const { toggleNotification } = useNotification()
  const [sending, setSending] = useState(false)
  const view = statusView(federation)
  const blockedId = blockedMessageId(federation)

  async function onFederate() {
    setSending(true)
    try {
      const result = await federate()
      const skipped =
        result.skipped > 0
          ? ` ${t('fediverse.panel.federate.skipped', { skipped: result.skipped })}`
          : ''
      toggleNotification({
        type: 'success',
        message: `${t('fediverse.panel.federate.queued', { activity: result.activity, queued: result.queued })}${skipped}`,
      })
    } catch (error) {
      toggleNotification({
        type: 'danger',
        message: t('fediverse.panel.federate.failed', {
          detail: t(problemMessageId(error instanceof FederateRefused ? error.code : undefined)),
        }),
      })
    } finally {
      setSending(false)
    }
  }

  return (
    <Flex direction="column" alignItems="stretch" gap={3}>
      <Flex direction="column" alignItems="flex-start" gap={1}>
        <Badge
          active={view.tone === 'success'}
          backgroundColor={view.tone === 'danger' ? 'danger100' : undefined}
          textColor={view.tone === 'danger' ? 'danger700' : undefined}
        >
          {t(view.messageId)}
        </Badge>
        {view.detailId ? (
          <Typography variant="pi" textColor="neutral600">
            {t(view.detailId, { attempts: federation.attempts })}
          </Typography>
        ) : null}
        {view.showTime && federation.lastActivityAt ? (
          <Typography variant="pi" textColor="neutral600">
            {t('fediverse.panel.state.queuedAt', { date: date(federation.lastActivityAt) })}
          </Typography>
        ) : null}
        {view.showError && federation.lastError ? (
          <Typography variant="pi" textColor="neutral600">
            {t('fediverse.panel.state.lastError', { error: federation.lastError })}
          </Typography>
        ) : null}
        {federation.state !== 'never' ? (
          <Typography variant="pi" textColor="neutral500">
            {t('fediverse.panel.state.noDelivery')}
          </Typography>
        ) : null}
      </Flex>

      <Counts federation={federation} />

      <Flex direction="column" alignItems="stretch" gap={1}>
        <Button
          variant="secondary"
          fullWidth
          loading={sending}
          disabled={blockedId != null}
          onClick={onFederate}
        >
          {t('fediverse.panel.federate')}
        </Button>
        <Typography variant="pi" textColor="neutral600">
          {blockedId ? t(blockedId) : t(federateHintId(federation))}
        </Typography>
        <Box>
          <Button variant="tertiary" size="S" onClick={refresh}>
            {t('fediverse.panel.refresh')}
          </Button>
        </Box>
      </Flex>
    </Flex>
  )
}

function Message({ children }: { children: ReactNode }) {
  return (
    <Typography variant="pi" textColor="neutral600">
      {children}
    </Typography>
  )
}

/**
 * The federation panel in the side column of an article's edit view: the state of its last
 * activity, the fediverse counts, and "Federate now". Hidden for other content types, for a
 * new entry and for an admin who may not read the article.
 */
export const FederationPanel: PanelComponent = ({ model, documentId, document }) => {
  const { t } = useMessages()
  const enabled = model === ARTICLE_UID && documentId != null
  const locale = document?.locale ?? ''
  // The state is read again when the document is saved or published.
  const refreshKey = `${document?.updatedAt ?? ''}|${document?.publishedAt ?? ''}`
  const { data, federate, refresh, retry } = useArticleFederation(
    enabled ? documentId : '',
    locale,
    refreshKey
  )

  if (!enabled || data.kind === 'hidden') return null

  let content: ReactNode
  if (data.kind === 'ready') {
    content = <Ready federation={data.federation} federate={federate} refresh={refresh} />
  } else if (data.kind === 'off') {
    content = <Message>{t('fediverse.panel.off')}</Message>
  } else if (data.kind === 'error') {
    content = (
      <Flex direction="column" alignItems="flex-start" gap={2}>
        <Message>{t('fediverse.panel.error')}</Message>
        <Button variant="tertiary" size="S" onClick={retry}>
          {t('fediverse.panel.retry')}
        </Button>
      </Flex>
    )
  } else {
    content = <Message>{t('fediverse.panel.loading')}</Message>
  }

  return { title: t(TITLE_ID), content }
}
