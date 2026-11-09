import { Box, Button, Flex, Typography } from '@strapi/design-system'
import type { ReactNode } from 'react'

import type { Resource } from '../page-api'
import { useMessages } from '../messages'

/** A titled block of the plugin page that shows its loading and error states itself. */
export function Section<T>({
  title,
  resource,
  retry,
  children,
}: {
  title: string
  resource: Resource<T>
  retry: () => void
  children: (data: T) => ReactNode
}) {
  const { t } = useMessages()
  return (
    <Box background="neutral0" hasRadius shadow="filterShadow" padding={6}>
      <Flex direction="column" alignItems="stretch" gap={4}>
        <Typography variant="delta" tag="h2">
          {title}
        </Typography>
        {resource.kind === 'loading' ? (
          <Typography textColor="neutral600">{t('fediverse.page.loading')}</Typography>
        ) : null}
        {resource.kind === 'error' ? (
          <Flex direction="column" alignItems="flex-start" gap={2}>
            <Typography textColor="neutral600">{t('fediverse.page.error')}</Typography>
            <Button variant="tertiary" size="S" onClick={retry}>
              {t('fediverse.page.retry')}
            </Button>
          </Flex>
        ) : null}
        {resource.kind === 'ready' ? children(resource.data) : null}
      </Flex>
    </Box>
  )
}
