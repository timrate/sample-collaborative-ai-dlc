import { CircleHelp, ExternalLink } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { docsUrl } from '@/lib/docs';
import { HELP_TOPICS, type HelpTopicId } from '@/lib/help-topics';
import { cn } from '@/lib/utils';

interface HelpTipProps {
  topic: HelpTopicId;
  side?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
}

/**
 * A small "?" button that opens a short explanation and a link to the guide.
 *
 * It is a popover rather than a hover tooltip so that it works with a click,
 * the keyboard and touch, and can hold a link. Place it next to a label, not
 * inside one, so clicking it does not focus the labelled control.
 */
export function HelpTip({ topic, side = 'top', className }: HelpTipProps) {
  const help = HELP_TOPICS[topic];
  const doc = 'doc' in help ? help.doc : undefined;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Help: ${help.title}`}
          className={cn(
            'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full align-middle text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
        >
          <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent side={side} className="w-80 space-y-2 p-3">
        <p className="text-sm font-medium">{help.title}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{help.body}</p>
        {doc && (
          <a
            href={docsUrl(doc)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            Read the guide
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        )}
      </PopoverContent>
    </Popover>
  );
}
