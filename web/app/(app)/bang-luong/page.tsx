'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Payroll').then((m) => m.Payroll), { ssr: false });
