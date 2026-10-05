# Future support only; ast.parse does not import or execute this module.
import subprocess,threading,hashlib,json,signal,datetime,time,os
from pathlib import Path
class OwnedEntry:
    def __init__(self,argv,outdir,receipt,absolute_outer_deadline):
        self.argv=list(argv);self.outdir=Path(outdir);self.receipt=receipt
        self.deadline=absolute_outer_deadline
        self.child=None;self.birth=None;self.threads=[];self.outputs={};self.files={}
        self.errors=[];self.primary=None;self.ready=threading.Event();self.closing=False
        self.streams={};self.reader_children=[]
    def record(self,row):
        try:self.receipt(row)
        except BaseException as error:self.errors.append(('receipt',error))
    def remaining(self):
        return max(0.0,self.deadline-time.monotonic())
    def birth_read(self,pid):
        argv=['ps','-o','pid=,ppid=,lstart=','-p',str(pid)]
        reader=None
        try:
            reader=subprocess.Popen(argv,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            self.reader_children.append(reader)
            out,err=reader.communicate(timeout=self.remaining());code=reader.wait(timeout=self.remaining())
            self.record({'kind':'birth-read','pid':reader.pid,'argv':argv,'exit':code,'stdoutHex':out.hex(),'stderrHex':err.hex(),'waitReaped':True,'readerOSBirth':'NOT_CAPTURED'})
            if code or not out.strip():return None
            return out.strip().decode('ascii','strict')
        except BaseException as error:
            self.errors.append(('birth-reader',error));return None
        finally:
            if reader is not None and reader.poll() is not None:
                try:reader.wait(timeout=self.remaining())
                except BaseException as error:self.errors.append(('birth-reader-wait',error))
            elif reader is not None:
                # Missing reader closure is honest uncertainty; no fabricated wait or forced exit.
                self.record({'kind':'birth-reader-unreaped','pid':reader.pid})
    def drain(self,name):
        self.ready.wait()
        stream=self.streams.get(name);output=self.outputs[name]
        h=hashlib.sha256();received=0;durable=0;EOF=False;failed=False
        try:
            if stream is None:return
            while True:
                raw=stream.read(65536)
                if not raw:EOF=True;break
                received+=len(raw);h.update(raw)
                # Receipt faults never interrupt raw consumption or the independent binary file.
                try:
                    n=0
                    while n<len(raw):
                        wrote=output.write(raw[n:])
                        if wrote is None or wrote<=0:raise OSError('Binary output made no progress')
                        n+=wrote;durable+=wrote
                    output.flush();os.fsync(output.fileno())
                except BaseException as error:
                    failed=True;self.errors.append((name+'-binary-custody',error))
                self.record({'kind':'binary-chunk','FD':name,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
        except BaseException as error:
            failed=True;self.errors.append((name+'-drain',error))
        finally:
            if stream is not None:
                try:stream.close()
                except BaseException as error:self.errors.append((name+'-stream-close',error));failed=True
            try:output.flush();os.fsync(output.fileno())
            except BaseException as error:self.errors.append((name+'-flush',error));failed=True
            try:output.close()
            except BaseException as error:self.errors.append((name+'-FD-close',error));failed=True
            self.files[name]={'path':str(self.outdir/(name+'.bin')),'receivedBytes':received,'durableBytes':durable,'receivedSHA256':h.hexdigest(),'actualEOF':EOF,'custodyComplete':EOF and received==durable and not failed}
    def start(self):
        try:
            # Prepare real drain consumers before Popen: thread-start failure creates no child.
            for name in ('stdout','stderr'):
                rawfd=os.open(self.outdir/(name+'.bin'),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
                try:
                    output=os.fdopen(rawfd,'wb',buffering=0)
                except BaseException:
                    try:os.close(rawfd)
                    except BaseException as error:self.errors.append((name+'-raw-FD-close',error))
                    raise
                self.outputs[name]=output
                thread=threading.Thread(target=self.drain,args=(name,));thread.start();self.threads.append(thread)
            try:
                self.child=subprocess.Popen(self.argv,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,shell=False)
            finally:
                if self.child is not None:self.streams={'stdout':self.child.stdout,'stderr':self.child.stderr}
                self.ready.set()  # Always unblock prepared consumers, including Popen failure.
            self.record({'kind':'owned-entry-launched','pid':self.child.pid,'argv':self.argv,'atUtc':datetime.datetime.now(datetime.timezone.utc).isoformat()})
            self.birth=self.birth_read(self.child.pid)
            self.record({'kind':'entry-birth','pid':self.child.pid,'birth':self.birth or 'NOT_CAPTURED','granularity':'ps lstart seconds+PID/PPID'})
            if self.birth is None:raise RuntimeError('Owned entry birth not verifiable')
            if self.errors:raise RuntimeError('Launch observation/custody failure')
            return self
        except BaseException as error:
            self.primary=error;self.ready.set()
            self._close_attempts()
            self.raise_errors()
    def _close_attempts(self):
        if self.closing:return
        self.closing=True;self.ready.set()
        if self.child is not None:
            try:
                if self.child.poll() is None:
                    current=self.birth_read(self.child.pid)
                    if self.birth is not None and current==self.birth:
                        self.child.send_signal(signal.SIGTERM)
                    else:
                        self.errors.append(('ownership',RuntimeError('Birth absent/mismatched; no signal issued')))
                        self.record({'kind':'entry-cleanup-unverifiable','pid':self.child.pid,'birth':self.birth,'current':current})
            except BaseException as error:self.errors.append(('entry-signal',error))
            try:
                code=self.child.wait(timeout=self.remaining())
                self.record({'kind':'entry-actual-wait-reap','pid':self.child.pid,'exit':code})
            except BaseException as error:self.errors.append(('entry-wait',error))
        for thread in self.threads:
            try:
                thread.join(timeout=self.remaining())
                if thread.is_alive():self.errors.append(('drain-liveness',RuntimeError('Owned drain not ended within original absolute deadline')))
            except BaseException as error:self.errors.append(('drain-join',error))
        for name,output in self.outputs.items():
            # A live drain owns its FD; never close it out from under an actual read/write.
            alive=any(thread.is_alive() for thread in self.threads)
            if not alive and not output.closed:
                try:output.close()
                except BaseException as error:self.errors.append((name+'-partial-FD-close',error))
        for reader in self.reader_children:
            if reader.poll() is not None:
                try:reader.wait(timeout=self.remaining())
                except BaseException as error:self.errors.append(('reader-final-wait',error))
        self.record({'kind':'owned-finally','FDs':self.files,'entryStillLive':self.child is not None and self.child.poll() is None,'liveDrains':sum(t.is_alive() for t in self.threads),'unreapedReaders':[r.pid for r in self.reader_children if r.poll() is None],'errors':[stage+':'+type(error).__name__ for stage,error in self.errors]})
    def raise_errors(self):
        errors=([self.primary] if self.primary is not None else [])+[e for _,e in self.errors]
        if errors:raise BaseExceptionGroup('Owned entry primary/observation/cleanup failure',errors)
    def close(self):
        self._close_attempts();self.raise_errors()
        return None if self.child is None else self.child.returncode
