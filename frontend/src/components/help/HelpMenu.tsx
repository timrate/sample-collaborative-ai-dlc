import { BookOpen, CircleHelp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DOCS_BASE_URL, docsUrl } from '@/lib/docs';
import { HELP_MENU_LINKS } from '@/lib/help-topics';

/** Header menu that opens the main user guides in a new tab. */
export function HelpMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Help and documentation">
          <CircleHelp className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Guides</DropdownMenuLabel>
        {HELP_MENU_LINKS.map((link) => (
          <DropdownMenuItem key={link.doc} asChild>
            <a href={docsUrl(link.doc)} target="_blank" rel="noopener noreferrer">
              {link.label}
            </a>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href={DOCS_BASE_URL} target="_blank" rel="noopener noreferrer">
            <BookOpen className="mr-2 h-4 w-4" />
            All documentation
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
