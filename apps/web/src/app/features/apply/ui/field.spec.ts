import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl, Validators } from '@angular/forms';

import { LjField } from './field.ts';

/**
 * The accessibility floor, asserted rather than assumed.
 *
 * These four claims are the reason the control is rendered by the wrapper
 * instead of projected into it: every one of them is a relationship between the
 * label, the control and the message, and a projected input is one the wrapper
 * cannot put an attribute on. If they hold here they hold for all forty fields,
 * which is the whole argument for the component existing.
 */
@Component({
  imports: [LjField],
  template: `
    <lj-field
      [control]="control"
      [label]="label()"
      [required]="required()"
      [hint]="hint()"
      [kind]="'email'"
    />
  `,
})
class Host {
  readonly control = new FormControl('', {
    nonNullable: true,
    validators: [Validators.email],
  });
  readonly label = signal('Contact email');
  readonly required = signal(false);
  readonly hint = signal<string | null>(null);
}

function render(): { host: Host; element: HTMLElement; detect: () => void } {
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return {
    host: fixture.componentInstance,
    element: fixture.nativeElement as HTMLElement,
    detect: () => fixture.detectChanges(),
  };
}

function inputOf(element: HTMLElement): HTMLInputElement {
  const input = element.querySelector('input');
  if (input === null) {
    throw new Error('the field rendered no control');
  }
  return input;
}

describe('lj-field', () => {
  it('points its label at the control it labels', () => {
    const { element } = render();
    const label = element.querySelector('label');
    expect(label?.getAttribute('for')).toBe(inputOf(element).id);
    expect(label?.textContent).toContain('Contact email');
  });

  it('describes the control with its hint', () => {
    const { host, element, detect } = render();
    host.hint.set('We will only use this to reach you about the application.');
    detect();

    const describedBy = inputOf(element).getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(element.querySelector('#' + String(describedBy))?.textContent).toContain(
      'only use this',
    );
  });

  // A message about a field nobody has visited is the wall of red this whole
  // option is built to avoid, one field at a time.
  it('says nothing about a control the applicant has not visited', () => {
    const { host, element, detect } = render();
    host.required.set(true);
    detect();

    expect(inputOf(element).getAttribute('aria-invalid')).toBeNull();
    expect(element.querySelector('[role="alert"]')).toBeNull();
  });

  it('marks the control invalid and describes it with the message, once touched', async () => {
    const { host, element, detect } = render();
    host.control.setValue('not-an-address');
    host.control.markAsTouched();
    detect();
    await Promise.resolve();
    detect();

    const input = inputOf(element);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const describedBy = input.getAttribute('aria-describedby');
    const message = element.querySelector('#' + String(describedBy));
    expect(message?.getAttribute('role')).toBe('alert');
    expect(message?.textContent).toContain('email address');
  });

  // The asterisk is decoration; the word is what a screen reader says. Colour
  // and a glyph are never the only carrier of a meaning.
  it('announces a required field in words, not only with an asterisk', () => {
    const { host, element, detect } = render();
    host.required.set(true);
    detect();

    expect(element.querySelector('.field__required')?.getAttribute('aria-hidden')).toBe('true');
    expect(element.querySelector('label')?.textContent).toContain('(required)');
  });
});
