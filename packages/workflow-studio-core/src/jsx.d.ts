// React 19+ @types/react removed the global JSX namespace; consumers must use
// React.JSX or import JSX from 'react'. Studio source was written against React 18's
// global JSX. To avoid editing dozens of .tsx files, we restore the global namespace
// here by aliasing it to React's namespace. This file is included automatically via
// tsconfig.json `include: ["src/**/*"]`.
import type { JSX as ReactJSX } from 'react';

declare global {
  namespace JSX {
    type Element = ReactJSX.Element;
    type ElementClass = ReactJSX.ElementClass;
    type ElementAttributesProperty = ReactJSX.ElementAttributesProperty;
    type ElementChildrenAttribute = ReactJSX.ElementChildrenAttribute;
    type LibraryManagedAttributes<C, P> = ReactJSX.LibraryManagedAttributes<C, P>;
    type IntrinsicAttributes = ReactJSX.IntrinsicAttributes;
    type IntrinsicClassAttributes<T> = ReactJSX.IntrinsicClassAttributes<T>;
    type IntrinsicElements = ReactJSX.IntrinsicElements;
  }
}

export {};
