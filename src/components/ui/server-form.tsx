"use client";

import { Alert, Button, Flex, Form, type FormInstance } from "antd";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { Dayjs } from "dayjs";

export type FormState = { error?: string; ok?: string };
export type FormAction = (prev: FormState, formData: FormData) => Promise<FormState>;

/** Form values as the FormData a server action expects. Dates become YYYY-MM-DD; arrays are comma-joined. */
export function toFormData(values: Record<string, unknown>): FormData {
  const fd = new FormData();
  for (const [key, v] of Object.entries(values)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "object" && v !== null && "format" in v) fd.set(key, (v as Dayjs).format("YYYY-MM-DD"));
    else if (Array.isArray(v)) fd.set(key, v.join(", "));
    else fd.set(key, String(v));
  }
  return fd;
}

/** A visible asterisk after required labels, hidden from screen readers (the field is already aria-required). */
function requiredMark(label: React.ReactNode, { required }: { required: boolean }) {
  return (
    <>
      {label}
      {required ? (
        <span aria-hidden className="required-mark">
          {" "}*
        </span>
      ) : null}
    </>
  );
}

/**
 * An antd form around a server action that returns `{ error }` or `{ ok }`.
 * Labels sit above the fields; the result is shown under the buttons.
 */
export function ServerForm({
  action,
  submitLabel,
  initialValues,
  children,
  extraButtons,
  form,
  resetOnSuccess = false,
}: {
  action: FormAction;
  submitLabel: string;
  initialValues?: Record<string, unknown>;
  children: React.ReactNode;
  extraButtons?: React.ReactNode;
  form?: FormInstance;
  resetOnSuccess?: boolean;
}) {
  const [own] = Form.useForm();
  const instance = form ?? own;
  const [state, setState] = useState<FormState>({});
  const [pending, start] = useTransition();
  const router = useRouter();

  const submit = (values: Record<string, unknown>) =>
    start(async () => {
      const result = await action({}, toFormData(values));
      setState(result);
      if (result.ok) {
        if (resetOnSuccess) instance.resetFields();
        router.refresh();
      }
    });

  return (
    <Form form={instance} layout="vertical" initialValues={initialValues} onFinish={submit} requiredMark={requiredMark}>
      {children}
      <Flex wrap gap={8} align="center">
        <Button type="primary" htmlType="submit" loading={pending}>
          {submitLabel}
        </Button>
        {extraButtons}
      </Flex>
      <div aria-live="polite" style={{ marginTop: state.error || state.ok ? 12 : 0 }}>
        {state.error ? <Alert type="error" showIcon title={state.error} /> : null}
        {state.ok ? <Alert type="success" showIcon title={state.ok} /> : null}
      </div>
    </Form>
  );
}
