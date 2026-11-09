import { Badge, Flex, Typography } from '@strapi/design-system'

import { useMessages } from '../messages'
import { useResource } from '../page-api'
import { checkLabelId, checkValue, fixMessageId, type Check } from '../page-state'
import { Section } from './Section'

/** The checks that say whether federation can work, each with the fix text when it fails. */
export function DiagnosticsSection() {
  const { t } = useMessages()
  const { resource, reload } = useResource<{ checks: Check[] }>('/diagnostics')

  return (
    <Section title={t('fediverse.page.diagnostics.title')} resource={resource} retry={reload}>
      {({ checks }) => (
        <Flex direction="column" alignItems="stretch" gap={4}>
          {checks.map((check) => {
            const fix = fixMessageId(check)
            const value = checkValue(check)
            return (
              <Flex key={check.id} direction="column" alignItems="flex-start" gap={1}>
                <Flex gap={3} alignItems="center">
                  <Typography fontWeight="bold">{t(checkLabelId(check))}</Typography>
                  {check.ok === true ? (
                    <Badge active>{t('fediverse.page.diagnostics.ok')}</Badge>
                  ) : null}
                  {check.ok === false ? (
                    <Badge backgroundColor="danger100" textColor="danger700">
                      {t('fediverse.page.diagnostics.fail')}
                    </Badge>
                  ) : null}
                  {value ? (
                    <Typography textColor="neutral600">
                      {'messageId' in value ? t(value.messageId) : value.text}
                    </Typography>
                  ) : null}
                </Flex>
                {fix ? (
                  <Typography variant="pi" textColor="neutral600">
                    <strong>{t('fediverse.page.diagnostics.fix')}:</strong> {t(fix)}
                  </Typography>
                ) : null}
              </Flex>
            )
          })}
        </Flex>
      )}
    </Section>
  )
}
