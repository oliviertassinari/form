import type { FormEvent } from 'react'
import { Store } from '@tanstack/store'
//
import type { DeepKeys, DeepValue, Updater } from './utils'
import { functionalUpdate, getBy, setBy } from './utils'
import type { FieldApi, FieldMeta, ValidationCause } from './FieldApi'

export type FormOptions<TData> = {
  defaultValues?: TData
  defaultState?: Partial<FormState<TData>>
  onSubmit?: (values: TData, formApi: FormApi<TData>) => void
  onInvalidSubmit?: (values: TData, formApi: FormApi<TData>) => void
  validate?: (values: TData, formApi: FormApi<TData>) => Promise<any>
  debugForm?: boolean
  defaultValidatePristine?: boolean
  defaultValidateOn?: ValidationCause
  defaultValidateAsyncOn?: ValidationCause
  defaultValidateAsyncDebounceMs?: number
}

export type FieldInfo<TFormData> = {
  instances: Record<string, FieldApi<any, TFormData>>
} & ValidationMeta

export type ValidationMeta = {
  validationCount?: number
  validationAsyncCount?: number
  validationPromise?: Promise<ValidationError>
  validationResolve?: (error: ValidationError) => void
  validationReject?: (error: unknown) => void
}

export type ValidationError = undefined | false | null | string

export type FormState<TData> = {
  values: TData
  // Form Validation
  isFormValidating: boolean
  formValidationCount: number
  isFormValid: boolean
  formError?: ValidationError
  // Fields
  fieldMeta: Record<DeepKeys<TData>, FieldMeta>
  isFieldsValidating: boolean
  isFieldsValid: boolean
  isSubmitting: boolean
  // General
  isTouched: boolean
  isSubmitted: boolean
  isValidating: boolean
  isValid: boolean
  canSubmit: boolean
  submissionAttempts: number
}

export function getDefaultFormState<TData>(
  defaultState: Partial<FormState<TData>>,
): FormState<TData> {
  return {
    values: {} as any,
    fieldMeta: {} as any,
    canSubmit: true,
    isFieldsValid: false,
    isFieldsValidating: false,
    isFormValid: false,
    isFormValidating: false,
    isSubmitted: false,
    isSubmitting: false,
    isTouched: false,
    isValid: false,
    isValidating: false,
    submissionAttempts: 0,
    formValidationCount: 0,
    ...defaultState,
  }
}

export class FormApi<TFormData> {
  // // This carries the context for nested fields
  options: FormOptions<TFormData> = {}
  store!: Store<FormState<TFormData>>
  // Do not use __state directly, as it is not reactive.
  // Please use form.useStore() utility to subscribe to state
  state!: FormState<TFormData>
  fieldInfo: Record<DeepKeys<TFormData>, FieldInfo<TFormData>> = {} as any
  fieldName?: string
  validationMeta: ValidationMeta = {}

  constructor(opts?: FormOptions<TFormData>) {
    this.store = new Store<FormState<TFormData>>(
      getDefaultFormState({
        ...opts?.defaultState,
        values: opts?.defaultValues ?? opts?.defaultState?.values,
        isFormValid: !opts?.validate,
      }),
      {
        onUpdate: (next) => {
          // Computed state
          const fieldMetaValues = Object.values(next.fieldMeta) as (
            | FieldMeta
            | undefined
          )[]

          const isFieldsValidating = fieldMetaValues.some(
            (field) => field?.isValidating,
          )

          const isFieldsValid = !fieldMetaValues.some((field) => field?.error)

          const isTouched = fieldMetaValues.some((field) => field?.isTouched)

          const isValidating = isFieldsValidating || next.isFormValidating
          const isFormValid = !next.formError
          const isValid = isFieldsValid && isFormValid
          const canSubmit =
            (next.submissionAttempts === 0 && !isTouched) ||
            (!isValidating && !next.isSubmitting && isValid)

          next = {
            ...next,
            isFieldsValidating,
            isFieldsValid,
            isFormValid,
            isValid,
            canSubmit,
            isTouched,
          }

          // Create a shortcut for the state
          // Write it back to the store
          this.store.state = next
          this.state = next
        },
      },
    )

    this.state = this.store.state

    this.update(opts || {})
  }

  update = (options: FormOptions<TFormData>) => {
    this.store.batch(() => {
      if (
        options.defaultState &&
        options.defaultState !== this.options.defaultState
      ) {
        this.store.setState((prev) => ({
          ...prev,
          ...options.defaultState,
        }))
      }

      if (options.defaultValues !== this.options.defaultValues) {
        this.store.setState((prev) => ({
          ...prev,
          values: options.defaultValues as TFormData,
        }))
      }
    })

    this.options = options
  }

  reset = () =>
    this.store.setState(() => getDefaultFormState(this.options.defaultValues!))

  validateAllFields = async () => {
    const fieldValidationPromises: Promise<ValidationError>[] = [] as any

    this.store.batch(() => {
      void (Object.values(this.fieldInfo) as FieldInfo<any>[]).forEach(
        (field) => {
          Object.values(field.instances).forEach((instance) => {
            // If any fields are not touched
            if (!instance.state.meta.isTouched) {
              // Mark them as touched
              instance.setMeta((prev) => ({ ...prev, isTouched: true }))
              // Validate the field
              if (instance.options.validate) {
                fieldValidationPromises.push(instance.validate())
              }
            }
          })
        },
      )
    })

    return Promise.all(fieldValidationPromises)
  }

  validateForm = async () => {
    const { validate } = this.options

    if (!validate) {
      return
    }

    // Use the formValidationCount for all field instances to
    // track freshness of the validation
    this.store.setState((prev) => ({
      ...prev,
      isValidating: true,
      formValidationCount: prev.formValidationCount + 1,
    }))

    const formValidationCount = this.state.formValidationCount

    const checkLatest = () =>
      formValidationCount === this.state.formValidationCount

    if (!this.validationMeta.validationPromise) {
      this.validationMeta.validationPromise = new Promise((resolve, reject) => {
        this.validationMeta.validationResolve = resolve
        this.validationMeta.validationReject = reject
      })
    }

    const doValidation = async () => {
      try {
        const error = await validate(this.state.values, this)

        if (checkLatest()) {
          this.store.setState((prev) => ({
            ...prev,
            isValidating: false,
            error: error
              ? typeof error === 'string'
                ? error
                : 'Invalid Form Values'
              : null,
          }))

          this.validationMeta.validationResolve?.(error)
        }
      } catch (err) {
        if (checkLatest()) {
          this.validationMeta.validationReject?.(err)
        }
      } finally {
        delete this.validationMeta.validationPromise
      }
    }

    doValidation()

    return this.validationMeta.validationPromise
  }

  handleSubmit = async (e: FormEvent & { __handled?: boolean }) => {
    e.preventDefault()
    e.stopPropagation()

    // Check to see that the form and all fields have been touched
    // If they have not, touch them all and run validation
    // Run form validation
    // Submit the form

    this.store.setState((old) => ({
      ...old,
      // Submittion attempts mark the form as not submitted
      isSubmitted: false,
      // Count submission attempts
      submissionAttempts: old.submissionAttempts + 1,
    }))

    // Don't let invalid forms submit
    if (!this.state.canSubmit) return

    this.store.setState((d) => ({ ...d, isSubmitting: true }))

    const done = () => {
      this.store.setState((prev) => ({ ...prev, isSubmitting: false }))
    }

    // Validate all fields
    await this.validateAllFields()

    // Fields are invalid, do not submit
    if (!this.state.isFieldsValid) {
      done()
      this.options.onInvalidSubmit?.(this.state.values, this)
      return
    }

    // Run validation for the form
    await this.validateForm()

    if (!this.state.isValid) {
      done()
      this.options.onInvalidSubmit?.(this.state.values, this)
      return
    }

    try {
      // Run the submit code
      await this.options.onSubmit?.(this.state.values, this)

      this.store.batch(() => {
        this.store.setState((prev) => ({ ...prev, isSubmitted: true }))
        done()
      })
    } catch (err) {
      done()
      throw err
    }
  }

  getFieldValue = <TField extends DeepKeys<TFormData>>(
    field: TField,
  ): DeepValue<TFormData, TField> => getBy(this.state.values, field)

  getFieldMeta = <TField extends DeepKeys<TFormData>>(
    field: TField,
  ): FieldMeta => {
    return this.state.fieldMeta[field]
  }

  getFieldInfo = <TField extends DeepKeys<TFormData>>(field: TField) => {
    return (this.fieldInfo[field] ||= {
      instances: {},
    })
  }

  setFieldMeta = <TField extends DeepKeys<TFormData>>(
    field: TField,
    updater: Updater<FieldMeta>,
  ) => {
    this.store.setState((prev) => {
      return {
        ...prev,
        fieldMeta: {
          ...prev.fieldMeta,
          [field]: functionalUpdate(updater, prev.fieldMeta[field]),
        },
      }
    })
  }

  setFieldValue = <TField extends DeepKeys<TFormData>>(
    field: TField,
    updater: Updater<DeepValue<TFormData, TField>>,
    opts?: { touch?: boolean },
  ) => {
    const touch = opts?.touch ?? true

    this.store.batch(() => {
      this.store.setState((prev) => {
        return {
          ...prev,
          values: setBy(prev.values, field, updater),
        }
      })

      if (touch) {
        this.setFieldMeta(field, (prev) => ({
          ...prev,
          isTouched: true,
        }))
      }
    })
  }

  pushFieldValue = <TField extends DeepKeys<TFormData>>(
    field: TField,
    value: DeepValue<TFormData, TField>,
    opts?: { touch?: boolean },
  ) => {
    return this.setFieldValue(
      field,
      (prev) => [...(Array.isArray(prev) ? prev : []), value] as any,
      opts,
    )
  }

  insertFieldValue = <TField extends DeepKeys<TFormData>>(
    field: TField,
    index: number,
    value: DeepValue<TFormData, TField>,
    opts?: { touch?: boolean },
  ) => {
    this.setFieldValue(
      field,
      (prev) => {
        // invariant( // TODO: bring in invariant
        //   Array.isArray(prev),
        //   `Cannot insert a field value into a non-array field. Check that this field's existing value is an array: ${field}.`
        // )
        return (prev as DeepValue<TFormData, TField>[]).map((d, i) =>
          i === index ? value : d,
        ) as any
      },
      opts,
    )
  }

  spliceFieldValue = <TField extends DeepKeys<TFormData>>(
    field: TField,
    index: number,
    opts?: { touch?: boolean },
  ) => {
    this.setFieldValue(
      field,
      (prev) => {
        // invariant( // TODO: bring in invariant
        //   Array.isArray(prev),
        //   `Cannot insert a field value into a non-array field. Check that this field's existing value is an array: ${field}.`
        // )
        return (prev as DeepValue<TFormData, TField>[]).filter(
          (_d, i) => i !== index,
        ) as any
      },
      opts,
    )
  }

  swapFieldValues = <TField extends DeepKeys<TFormData>>(
    field: TField,
    index1: number,
    index2: number,
  ) => {
    this.setFieldValue(field, (prev: any) => {
      const prev1 = prev[index1]!
      const prev2 = prev[index2]!
      return setBy(setBy(prev, [index1], prev2), [index2], prev1)
    })
  }
}