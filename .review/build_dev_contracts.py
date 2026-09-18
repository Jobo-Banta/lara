from pathlib import Path
import json,re
R=Path('D:/DCP/LARA'); D=R/'docs/development'; C=D/'contracts'
def save(n,o): (C/n).write_text(json.dumps(o,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
def ref(n):return {'$ref':'#/components/schemas/'+n}
def obj(props,required=None):return {'type':'object','additionalProperties':False,'properties':props,'required':list(props) if required is None else required}
def enum(*v):return {'type':'string','enum':list(v)}
def arr(v,min=0):return {'type':'array','items':v,'minItems':min}
S={'Id':{'type':'string','format':'uuid'},'Text':{'type':'string','minLength':1,'maxLength':500},'Money':{'type':'string','pattern':r'^\d{1,18}(\.\d{1,6})?$'},'SignedDecimal':{'type':'string','pattern':r'^-?\d{1,18}(\.\d{1,6})?$'},'Rate':{'type':'string','pattern':r'^\d{1,12}(\.\d{1,12})?$'},'Date':{'type':'string','format':'date'},'Timestamp':{'type':'string','format':'date-time'},'Currency':{'type':'string','pattern':'^[A-Z]{3}$'}}
I=ref('Id'); T=ref('Text'); M=ref('Money'); F=ref('Date'); U=ref('Currency'); V={'type':'integer','minimum':1}
S['Dimensions']={'type':'object','additionalProperties':I,'maxProperties':20,'description':'Keys are approved dimension type codes; values are scoped dimension IDs.'}
S['EntityCreate']=obj({'legalName':T,'baseCurrency':U,'timezone':T,'fiscalYearStartMonth':{'type':'integer','minimum':1,'maximum':12},'registrationProfileId':I},['legalName','baseCurrency','timezone','fiscalYearStartMonth'])
S['BranchCreate']=obj({'code':T,'name':T,'address':T})
S['PartyCreate']=obj({'legalName':T,'roles':arr(enum('customer','supplier','employee','bank'),1),'identityStatus':enum('known','unknown','not_applicable'),'taxId':T,'address':T},['legalName','roles','identityStatus','address'])
S['MembershipCreate']=obj({'principalId':I,'roleId':I,'branchIds':arr(I),'validUntil':ref('Timestamp')},['principalId','roleId','branchIds'])
S['RoleCreate']=obj({'code':T,'name':T,'permissions':arr(T,1)})
S['ApprovalPolicyCreate']=obj({'documentKind':T,'effectiveFrom':F,'steps':arr(obj({'roleId':I,'minimumAmount':M,'maximumAmount':M,'distinctActorRequired':{'type':'boolean','const':True}}),1),'sourceEvidenceIds':arr(I,1)})
S['CapabilityActivation']=obj({'capability':T,'profileVersion':T,'evidenceIds':arr(I,1),'reason':T})
S['TaskCreate']=obj({'kind':T,'sourceType':T,'sourceId':I,'ownerId':I,'dueAt':ref('Timestamp'),'reason':T},['kind','sourceType','sourceId','reason'])
S['ObligationCreate']=obj({'kind':T,'periodKey':T,'dueAt':ref('Timestamp'),'ownerId':I,'ruleVersion':T})
S['EvidenceUpload']=obj({'filename':T,'mime':enum('application/pdf','image/jpeg','image/png','text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),'byteCount':{'type':'integer','minimum':1,'maximum':20971520},'sha256':{'type':'string','pattern':'^[a-f0-9]{64}$'},'classification':enum('internal','confidential','restricted')})
S['Action']=obj({'reason':T,'evidenceIds':arr(I)},[])
S['ReasonAction']=obj({'reason':T,'evidenceIds':arr(I)},['reason'])
S['AssignTask']=obj({'ownerId':I,'dueAt':ref('Timestamp'),'reason':T},['ownerId','reason'])
S['CommentCreate']=obj({'body':T,'evidenceIds':arr(I)},['body'])
S['ApprovalDecision']=obj({'decision':enum('approve','reject'),'contentVersion':V,'reason':T},['decision','contentVersion'])
S['AccountCreate']=obj({'bookId':I,'code':T,'name':T,'category':enum('asset','liability','equity','income','expense'),'parentId':I,'controlType':enum('ar','ap','inventory','input_tax','output_tax','advance','none'),'requiredDimensions':arr(T)},['bookId','code','name','category','controlType','requiredDimensions'])
S['JournalLine']=obj({'accountId':I,'branchId':I,'debit':M,'credit':M,'dimensions':ref('Dimensions')})
S['JournalCreate']=obj({'bookId':I,'accountingDate':F,'documentDate':F,'currency':U,'description':T,'lines':arr(ref('JournalLine'),2),'evidenceIds':arr(I)})
S['Reversal']=obj({'accountingDate':F,'reason':T,'evidenceIds':arr(I)},['accountingDate','reason'])
S['ImportCreate']=obj({'kind':enum('masters','openings','journal','bank_statement','inventory','assets','payroll_tax','tax_adjustments','payroll','marketplace','pos','source_balances'),'evidenceId':I,'mappingVersion':T,'sourceId':T,'externalBatchId':T,'cutoffDate':F})
S['DocumentLine']=obj({'description':T,'itemId':I,'quantity':M,'unitPrice':M,'discount':M,'priceBasis':enum('exclusive','inclusive'),'accountId':I,'taxCodeId':I,'dimensions':ref('Dimensions')},['description','quantity','unitPrice','discount','priceBasis','accountId','dimensions'])
S['DocumentCreate']=obj({'kind':enum('invoice','bill','quotation','sales_order','purchase_order','credit_note','expense_claim'),'branchId':I,'bookId':I,'partyId':I,'documentDate':F,'accountingDate':F,'currency':U,'ruleProfileVersion':T,'externalReference':T,'sourceDocumentId':I,'lines':arr(ref('DocumentLine'),1),'evidenceIds':arr(I)},['kind','branchId','bookId','partyId','documentDate','accountingDate','currency','ruleProfileVersion','lines','evidenceIds'])
S['DocumentCorrection']=obj({'kind':enum('credit_note','additional_invoice','reversal'),'accountingDate':F,'reason':T,'lines':arr(ref('DocumentLine'),1),'evidenceIds':arr(I)},['kind','accountingDate','reason','lines'])
S['Allocation']=obj({'openItemId':I,'amount':M})
S['SettlementCreate']=obj({'direction':enum('receipt','payment'),'partyId':I,'bankAccountId':I,'currency':U,'valueDate':F,'grossAmount':M,'cashAmount':M,'withholdingAmount':M,'method':enum('cash','transfer','check','wallet','card'),'allocations':arr(ref('Allocation')),'evidenceIds':arr(I)},['direction','partyId','currency','valueDate','grossAmount','cashAmount','withholdingAmount','method','allocations','evidenceIds'])
S['PaymentCreate']=obj({'settlementId':I,'beneficiaryVersionId':I,'scheduledDate':F,'reason':T},['settlementId','beneficiaryVersionId','scheduledDate'])
S['PaymentRelease']=obj({'channel':enum('manual','bank_file','qualified_api'),'externalReference':T,'evidenceIds':arr(I,1)})
S['BankAccountCreate']=obj({'bookId':I,'ledgerAccountId':I,'bankCode':T,'accountNumber':T,'currency':U,'evidenceIds':arr(I,1)})
S['BankMatch']=obj({'statementLineIds':arr(I,1),'allocations':arr(obj({'resourceType':enum('settlement','journal'),'resourceId':I,'amount':M}),1),'reason':T},['statementLineIds','allocations'])
S['TransferCreate']=obj({'fromAccountId':I,'toAccountId':I,'currency':U,'amount':M,'valueDate':F,'evidenceIds':arr(I)})
S['CheckCreate']=obj({'direction':enum('received','issued'),'bankAccountId':I,'number':T,'amount':M,'currency':U,'dueDate':F,'partyId':I,'settlementId':I},['direction','bankAccountId','number','amount','currency','dueDate','partyId'])
S['CashSessionCreate']=obj({'branchId':I,'cashierId':I,'businessDate':F,'openingAmount':M})
S['CashCount']=obj({'lines':arr(obj({'denomination':M,'quantity':{'type':'integer','minimum':0}}),1),'reason':T,'evidenceIds':arr(I)},['lines','evidenceIds'])
S['TaxRuleCreate']=obj({'code':T,'taxType':enum('vat','withholding','grt','dst','percentage'),'validFrom':F,'validTo':F,'rate':ref('Rate'),'basis':enum('net','gross','instrument','approved_expression'),'recognition':enum('issue','accrual','payment','profile_event'),'rounding':enum('line_half_up','document_half_up'),'applicabilityProfileId':I,'sourceEvidenceIds':arr(I,1),'goldenCaseIds':arr(T,1)},['code','taxType','validFrom','rate','basis','recognition','rounding','applicabilityProfileId','sourceEvidenceIds','goldenCaseIds'])
S['ReturnCreate']=obj({'formCode':T,'periodStart':F,'periodEnd':F,'profileVersion':T,'dataCutoff':ref('Timestamp')})
S['FilingEvidence']=obj({'externalReference':T,'filedAt':ref('Timestamp'),'evidenceIds':arr(I,1)})
S['SettlementEvidence']=obj({'externalReference':T,'settledAt':ref('Timestamp'),'valueDate':F,'evidenceIds':arr(I,1)})
S['ReportRequest']=obj({'reportType':T,'bookId':I,'periodStart':F,'periodEnd':F,'asOf':ref('Timestamp'),'currency':U,'format':enum('json','csv','pdf'),'dimensions':ref('Dimensions')},['reportType','bookId','periodStart','periodEnd','asOf','format'])
S['ExportRequest']=obj({'kind':enum('evidence_manifest','tasks','masters','report'),'resourceIds':arr(I),'report':ref('ReportRequest'),'format':enum('json','csv','pdf')},['kind','resourceIds','format'])
S['ExportRequest']['description']='kind=report requires report; other kinds prohibit report. An empty resourceIds list selects only the authorized query scope at the recorded snapshot cutoff; maximum row/cost limits apply.'
S['PeriodCreate']=obj({'bookId':I,'startsOn':F,'endsOn':F})
S['SourceOwnershipCreate']=obj({'sourceSystem':T,'bookId':I,'transactionFamily':T,'effectiveFrom':F,'effectiveTo':F,'evidenceIds':arr(I,1)},['sourceSystem','bookId','transactionFamily','effectiveFrom','evidenceIds'])
S['FxRateCreate']=obj({'baseCurrency':U,'quoteCurrency':U,'rateDate':F,'rate':ref('Rate'),'sourceEvidenceId':I})
S['RevaluationCreate']=obj({'bookId':I,'periodId':I,'rateSetId':I,'accountIds':arr(I,1),'reverseNextPeriod':{'type':'boolean'}})
S['BookCreate']=obj({'code':T,'kind':enum('primary','rbu','fcdu','trust','management'),'functionalCurrency':U,'sourceOwner':T})
S['ItemCreate']=obj({'sku':T,'description':T,'uom':T,'costMethod':enum('fifo','moving_average'),'tracking':enum('none','batch','serial'),'stockAccountId':I,'cogsAccountId':I})
S['StockLine']=obj({'itemId':I,'quantity':M,'unitCost':M,'lotOrSerial':T},['itemId','quantity'])
S['StockMovementCreate']=obj({'kind':enum('receipt','issue','transfer','return','adjustment'),'warehouseId':I,'toWarehouseId':I,'accountingDate':F,'sourceDocumentId':I,'lines':arr(ref('StockLine'),1),'reason':T},['kind','warehouseId','accountingDate','lines'])
S['CountCreate']=obj({'warehouseId':I,'cutoffAt':ref('Timestamp'),'lines':arr(obj({'itemId':I,'observedQuantity':M}),1),'evidenceIds':arr(I)})
S['LandedCostCreate']=obj({'chargeDocumentId':I,'receiptIds':arr(I,1),'method':enum('value','quantity','weight'),'amount':M})
S['AssetCreate']=obj({'tag':T,'classId':I,'cost':M,'residual':M,'currency':U,'inServiceDate':F,'usefulLifeMonths':{'type':'integer','minimum':1},'method':enum('straight_line','declining_balance','sum_of_years'),'sourceDocumentId':I,'locationId':I,'custodianId':I},['tag','classId','cost','residual','currency','inServiceDate','usefulLifeMonths','method','sourceDocumentId'])
S['AssetEvent']=obj({'kind':enum('transfer','split','merge','disposal','impairment','revaluation','capitalize_cip'),'effectiveDate':F,'amount':M,'proceeds':M,'relatedAssetIds':arr(I),'targetLocationId':I,'reason':T,'evidenceIds':arr(I,1)},['kind','effectiveDate','reason','evidenceIds'])
S['ScheduleCreate']=obj({'kind':enum('depreciation','prepayment','deferred_revenue','recurring_invoice','recurring_journal','employee_deduction'),'sourceId':I,'startDate':F,'endDate':F,'basisAmount':M,'currency':U,'policyVersion':T})
S['ScheduleRun']=obj({'periodId':I,'scheduleIds':arr(I,1)})
S['AiRequest']=obj({'feature':enum('capture','coding','matching','explain','ask_books','close_draft','audit_pack','registration_draft'),'evidenceIds':arr(I),'resourceIds':arr(I),'question':T,'reportRequest':ref('ReportRequest')},['feature','evidenceIds','resourceIds'])
S['AiReview']=obj({'decision':enum('accept','edit','reject'),'fieldChanges':arr(obj({'path':T,'value':{'type':['string','number','boolean','null']}})),'reason':T},['decision','fieldChanges'])
S['PortalInvite']=obj({'partyId':I,'email':{'type':'string','format':'email'},'role':enum('customer','supplier'),'expiresAt':ref('Timestamp')})
S['MessageCreate']=obj({'sourceType':T,'sourceId':I,'recipientPartyId':I,'channel':enum('portal','email','qualified_chat'),'templateVersion':T})
S['PaymentLinkCreate']=obj({'invoiceId':I,'amount':M,'currency':U,'expiresAt':ref('Timestamp')})
S['FirmMandateCreate']=obj({'firmId':I,'permissions':arr(T,1),'entityIds':arr(I,1),'validUntil':ref('Timestamp'),'evidenceIds':arr(I,1)})
S['FirmAssignment']=obj({'mandateId':I,'principalId':I,'entityIds':arr(I,1),'permissionSubset':arr(T,1)})
S['GroupCreate']=obj({'name':T,'reportingCurrency':U,'members':arr(obj({'entityId':I,'ownershipPercent':ref('Rate'),'method':enum('full'),'effectiveFrom':F}),1)})
S['ConsolidationCreate']=obj({'groupId':I,'periodEnd':F,'memberSnapshotIds':arr(I,1),'rateSetId':I,'mappingVersion':T})
S['IntercompanyCreate']=obj({'sourceEntityId':I,'targetEntityId':I,'sourceDocumentId':I,'targetDraft':ref('DocumentCreate')})
S['BudgetCreate']=obj({'periodStart':F,'periodEnd':F,'currency':U,'policy':enum('warn','block'),'lines':arr(obj({'accountId':I,'dimensions':ref('Dimensions'),'amount':M}),1)})
S['AllocationRunCreate']=obj({'ruleVersionId':I,'periodId':I,'sourceCutoff':ref('Timestamp'),'driverEvidenceId':I})
S['ProjectCreate']=obj({'code':T,'customerId':I,'contractAmount':M,'currency':U,'evidenceIds':arr(I,1)})
S['ProgressBilling']=obj({'milestoneId':I,'certifiedAmount':M,'retentionAmount':M,'advanceRecoupment':M,'accountingDate':F,'evidenceIds':arr(I,1)})
S['LeaseCreate']=obj({'partyId':I,'startDate':F,'endDate':F,'currency':U,'deposit':M,'advance':M,'billingScheduleId':I,'withholdingProfileVersion':T,'evidenceIds':arr(I,1)})
S['DiscountEligibility']=obj({'partyId':I,'category':T,'profileVersion':T,'validUntil':F,'evidenceIds':arr(I,1)})
S['ReportDefinitionCreate']=obj({'name':T,'metricIds':arr(T,1),'dimensionIds':arr(T),'filters':arr(obj({'field':T,'operator':enum('eq','in','gte','lte'),'values':arr(T,1)})),'sort':arr(obj({'field':T,'direction':enum('asc','desc')}))})
S['RuleProposalCreate']=obj({'sourceEvidenceIds':arr(I,1),'affectedProfileIds':arr(I,1),'proposedRuleIds':arr(I),'goldenCaseIds':arr(T,1)})
S['ToolGrantCreate']=obj({'clientId':I,'tools':arr(enum('read_report','read_evidence','propose_draft','propose_task'),1),'entityIds':arr(I,1),'expiresAt':ref('Timestamp')})
S['PackInstall']=obj({'packId':T,'version':T,'manifestHash':{'type':'string','pattern':'^[a-f0-9]{64}$'},'evidenceIds':arr(I,1)})
S['DemoScenario']=obj({'scenario':enum(*[f'DEMO-{n:02}' for n in range(1,9)])})
S['FeedbackCreate']=obj({'scenario':T,'route':T,'severity':enum('blocker','major','minor','suggestion'),'body':T})
S['Error']=obj({'code':T,'message':T,'traceId':T,'fieldErrors':arr(obj({'path':T,'message':T})),'retryable':{'type':'boolean'},'resourceVersion':V},['code','message','traceId','fieldErrors','retryable'])
S['Resource']=obj({'id':I,'version':V,'contentVersion':V,'state':T,'createdAt':ref('Timestamp'),'updatedAt':ref('Timestamp'),'simulation':{'type':'boolean'}})
S['CommandResult']=obj({'resourceType':T,'resourceId':I,'version':V,'state':T,'journalEntryIds':arr(I),'taskIds':arr(I),'traceId':T,'simulation':{'type':'boolean'}})
S['Job']=obj({'id':I,'state':enum('queued','running','retry_wait','succeeded','failed','dead_letter'),'statusUrl':T,'traceId':T,'resultResourceType':{'type':['string','null']},'resultResourceId':{'type':['string','null'],'format':'uuid'}})
S['UploadResult']=obj({'evidenceId':I,'version':V,'uploadUrl':T,'expiresAt':ref('Timestamp'),'state':enum('quarantined')})
S['EvidenceResource']=obj({'id':I,'version':V,'filename':T,'mime':T,'byteCount':{'type':'integer','minimum':1},'sha256':T,'state':enum('quarantined','scanning','available','rejected'),'classification':enum('internal','confidential','restricted'),'simulation':{'type':'boolean'}})
S['OpenItemView']=obj({'id':I,'documentId':I,'partyId':I,'side':enum('AR','AP'),'currency':U,'originalAmount':M,'allocatedAmount':M,'outstandingAmount':M,'dueDate':F,'version':V})
S['OpenItemList']=obj({'items':arr(ref('OpenItemView')),'nextCursor':{'type':['string','null']}})
S['ApplyAllocations']=obj({'allocations':arr(ref('Allocation'),1),'reason':T},['allocations'])
S['TransmissionResource']=obj({'id':I,'documentId':I,'version':V,'state':enum('not_applicable','queued','sending','accepted','rejected','unknown','retry_wait'),'payloadVersion':V,'payloadHash':T,'profileVersion':T,'deadlineAt':{'type':['string','null'],'format':'date-time'},'remoteId':{'type':['string','null']},'attemptCount':{'type':'integer','minimum':0},'simulation':{'type':'boolean'}})
S['AiSuggestionResource']=obj({'id':I,'version':V,'state':enum('proposed','accepted','edited','rejected','abstained'),'runId':I,'fields':arr(obj({'path':T,'value':{'type':['string','number','boolean','null']},'evidenceId':I,'sourceLocator':T,'uncertainty':enum('low','medium','high','unknown')})),'modelVersion':T,'simulation':{'type':'boolean'}})
S['Health']=obj({'status':enum('ok','degraded'),'build':T})
S['SessionContext']=obj({'principalId':I,'tenantId':I,'entityIds':arr(I),'permissions':arr(T),'capabilities':arr(T),'revocationVersion':V,'simulation':{'type':'boolean'}})

paths={}; operations=[]
def add(method,path,phase,permission,input=None,response='CommandResult',mutation=False,async_=False,entity=True):
    opid=re.sub(r'[^a-zA-Z0-9]+','_',method+'_'+path).strip('_')
    pars=[{'name':x,'in':'path','required':True,'schema':I if x!='key' else T} for x in re.findall(r'{(\w+)}',path)]
    if entity: pars.append({'name':'X-Entity-Id','in':'header','required':True,'schema':I})
    if method=='post': pars.append({'name':'Idempotency-Key','in':'header','required':True,'schema':T})
    if mutation: pars.append({'name':'If-Match','in':'header','required':True,'schema':{'type':'string','pattern':'^"[1-9][0-9]*"$'}})
    code='202' if async_ else '201' if method=='post' and not mutation else '200'
    op={'operationId':opid,'summary':permission.replace('.',' '),'tags':[phase],'x-delivery-phase':phase,'x-required-permission':permission,'x-scope':'entity' if entity else 'tenant','parameters':pars,'responses':{code:{'description':'Queued job; financial posting is not yet complete' if async_ else 'Committed local result','headers':{'ETag':{'schema':{'type':'string'},'description':'Quoted resource version where a resource is returned'}},'content':{'application/json':{'schema':ref('Job' if async_ else response)}}}}}
    if input:op['requestBody']={'required':True,'content':{'application/json':{'schema':ref(input)}}}
    for err in ['401','403','404','409','412','422','428','429','503']:op['responses'][err]={'description':'Typed failure; see API error contract','content':{'application/json':{'schema':ref('Error')}}}
    paths.setdefault(path,{})[method]=op; operations.append({'operationId':opid,'phase':phase,'method':method.upper(),'path':path,'permission':permission,'input':input,'response':'Job' if async_ else response})

def resource(name,schema,phase,actions=(),entity=True):
    # Typed read models expose creation fields plus server identity/status, and derived totals separately.
    rn=schema.replace('Create','')+'Resource'
    if rn not in S:
        props={**S[schema]['properties'],**S['Resource']['properties']}
        S[rn]=obj(props,list(S[schema]['required'])+list(S['Resource']['required']))
        if schema=='BankAccountCreate':
            S[rn]['properties'].pop('accountNumber');S[rn]['properties']['accountNumberMasked']=T
            S[rn]['required'].remove('accountNumber');S[rn]['required'].append('accountNumberMasked')
        if schema=='PartyCreate':
            S[rn]['properties'].pop('taxId');S[rn]['properties']['taxIdMasked']=T
        if schema=='DocumentCreate':
            S[rn]['properties'].update({'net':M,'tax':M,'gross':M,'officialNumber':{'type':['string','null']},'deliveryState':enum('not_requested','queued','sent','delivered','failed'),'reportingState':enum('not_applicable','queued','sending','accepted','rejected','unknown','retry_wait'),'settlementState':enum('unpaid','partial','paid','credit_balance')})
            S[rn]['required']+=['net','tax','gross','officialNumber','deliveryState','reportingState','settlementState']
    ln=rn+'List';S[ln]=obj({'items':arr(ref(rn)),'nextCursor':{'type':['string','null']}})
    p='/'+name
    add('post',p,phase,name+'.create',schema,rn,entity=entity)
    add('get',p,phase,name+'.read',response=ln,entity=entity)
    paths[p]['get']['parameters'] += [{'name':'cursor','in':'query','schema':T},{'name':'limit','in':'query','schema':{'type':'integer','minimum':1,'maximum':200,'default':50}}]
    add('get',p+'/{id}',phase,name+'.read',response=rn,entity=entity)
    add('patch',p+'/{id}',phase,name+'.edit',schema,rn,mutation=True,entity=entity)
    paths[p+'/{id}']['patch']['description']='Full draft replacement under optimistic version check; permitted only in editable state. Posted content is immutable. Server ignores no fields: unexpected fields are rejected.'
    if schema in ['BankAccountCreate','PartyCreate']:
        editname=schema.replace('Create','Edit')
        sensitive='accountNumber' if schema=='BankAccountCreate' else 'taxId'
        S[editname]=obj(S[schema]['properties'],[k for k in S[schema]['required'] if k!=sensitive])
        paths[p+'/{id}']['patch']['requestBody']['content']['application/json']['schema']=ref(editname)
        paths[p+'/{id}']['patch']['description']+=' Omitted sensitive identity/account field preserves the stored value; supplied field creates a separately reviewed version. Masked display values are rejected as input.'
        operations[-1]['input']=editname
    for action,body in actions:add('post',p+'/{id}/'+action,phase,name+'.'+action,body,mutation=True,entity=entity)

std=[('submit','Action'),('approve','ApprovalDecision'),('post','Action')]
resource('entities','EntityCreate','P02',[('activate','ReasonAction')],False)
resource('branches','BranchCreate','P02')
resource('parties','PartyCreate','P02',[('archive','ReasonAction')])
resource('memberships','MembershipCreate','P02',[('revoke','ReasonAction')])
resource('roles','RoleCreate','P02',[('approve','ApprovalDecision')])
resource('approval-policies','ApprovalPolicyCreate','P02',[('approve','ApprovalDecision'),('activate','ReasonAction')])
add('get','/me','P02','session.read',response='SessionContext',entity=False)
add('post','/capabilities/activate','P02','capability.activate','CapabilityActivation')
resource('tasks','TaskCreate','P02',[('assign','AssignTask'),('resolve','ReasonAction'),('comments','CommentCreate')])
resource('obligations','ObligationCreate','P02',[('complete','ReasonAction')])
add('post','/evidence/uploads','P02','evidence.upload','EvidenceUpload','UploadResult')
add('post','/evidence/{id}/complete','P02','evidence.upload','Action',mutation=True,async_=True)
add('get','/evidence/{id}','P02','evidence.read',response='EvidenceResource')
add('get','/evidence/{id}/content','P02','evidence.read',response='EvidenceResource')
paths['/evidence/{id}/content']['get']['responses']['200']['content']={'application/octet-stream':{'schema':{'type':'string','format':'binary'}}}
add('post','/exports','P02','evidence.export','ExportRequest',async_=True)
add('get','/commands/{key}','P02','command.read',response='CommandResult')
add('get','/jobs/{id}','P02','job.read',response='Job')
resource('accounts','AccountCreate','P03')
resource('journals','JournalCreate','P03',std+[('reverse','Reversal')])
resource('periods','PeriodCreate','P03',[('soft-close','ReasonAction'),('lock','ReasonAction'),('reopen','ReasonAction')])
resource('imports','ImportCreate','P03',[('validate','Action'),('approve','ApprovalDecision'),('commit','Action')])
add('post','/reports','P03','report.generate','ReportRequest',async_=True)
resource('tax-rules','TaxRuleCreate','P04',[('approve','ApprovalDecision'),('activate','ReasonAction')])
resource('invoices','DocumentCreate','P04',std+[('correct','DocumentCorrection'),('deliver','Action')])
resource('sales-orders','DocumentCreate','P04',[('submit','Action'),('approve','ApprovalDecision'),('convert','Action')])
resource('collections','SettlementCreate','P04',std+[('reverse','Reversal')])
add('get','/open-items','P04','open_item.read',response='OpenItemList')
paths['/open-items']['get']['parameters'] += [{'name':'partyId','in':'query','schema':I},{'name':'side','in':'query','required':True,'schema':enum('AR','AP')},{'name':'cursor','in':'query','schema':T},{'name':'limit','in':'query','schema':{'type':'integer','minimum':1,'maximum':200,'default':50}}]
add('post','/collections/{id}/allocations','P04','collection.allocate','ApplyAllocations',mutation=True)
add('post','/allocations/{id}/reverse','P04','allocation.reverse','ReasonAction',mutation=True)
resource('bills','DocumentCreate','P05',std+[('correct','DocumentCorrection')])
resource('purchase-orders','DocumentCreate','P05',[('submit','Action'),('approve','ApprovalDecision'),('cancel','ReasonAction')])
resource('expense-claims','DocumentCreate','P05',std)
resource('settlements','SettlementCreate','P05',[('submit','Action')])
resource('payments','PaymentCreate','P05',[('submit','Action'),('authorize','ApprovalDecision'),('release','PaymentRelease'),('settle','SettlementEvidence'),('return','Reversal')])
resource('bank-accounts','BankAccountCreate','P06',[('approve','ApprovalDecision')])
resource('bank-matches','BankMatch','P06',[('confirm','ApprovalDecision'),('reverse','ReasonAction')])
resource('transfers','TransferCreate','P06',std)
resource('checks','CheckCreate','P06',[('release','ReasonAction'),('deposit','ReasonAction'),('clear','ReasonAction'),('dishonor','Reversal')])
resource('cash-sessions','CashSessionCreate','P06',[('count','CashCount'),('close','ReasonAction'),('handover','ApprovalDecision')])
resource('returns','ReturnCreate','P07',[('prepare','Action'),('approve','ApprovalDecision'),('filed','FilingEvidence')])
add('post','/transmissions/{id}/reconcile','P07','transmission.reconcile','ReasonAction',mutation=True,async_=True)
add('post','/transmissions/{id}/retry','P07','transmission.retry','ReasonAction',mutation=True,async_=True)
add('get','/transmissions/{id}','P07','transmission.read',response='TransmissionResource')
add('post','/registration-packs','P07','registration.prepare','ReportRequest',async_=True)
resource('source-ownership','SourceOwnershipCreate','P08',[('approve','ApprovalDecision')])
resource('books','BookCreate','P09',[('activate','ReasonAction')])
resource('fx-rates','FxRateCreate','P09',[('approve','ApprovalDecision')])
resource('revaluations','RevaluationCreate','P09',[('preview','Action'),('approve','ApprovalDecision'),('post','Action')])
resource('items','ItemCreate','P10')
resource('stock-movements','StockMovementCreate','P10',std)
resource('stock-counts','CountCreate','P10',[('approve','ApprovalDecision'),('post','Action')])
resource('landed-costs','LandedCostCreate','P10',[('preview','Action'),('approve','ApprovalDecision'),('post','Action')])
resource('assets','AssetCreate','P11',[('approve','ApprovalDecision'),('events','AssetEvent')])
resource('schedules','ScheduleCreate','P11',[('approve','ApprovalDecision'),('pause','ReasonAction')])
add('post','/schedule-runs','P11','schedule.execute','ScheduleRun',async_=True)
add('post','/assistant/runs','P12','assistant.suggest','AiRequest',async_=True)
add('post','/assistant/suggestions/{id}/review','P12','assistant.review','AiReview',mutation=True)
add('get','/assistant/suggestions/{id}','P12','assistant.read',response='AiSuggestionResource')
resource('portal-invites','PortalInvite','P13',[('revoke','ReasonAction')])
resource('message-requests','MessageCreate','P13',[('send','ReasonAction')])
resource('payment-links','PaymentLinkCreate','P13',[('cancel','ReasonAction')])
resource('firm-mandates','FirmMandateCreate','P14',[('approve','ApprovalDecision'),('revoke','ReasonAction')])
resource('firm-assignments','FirmAssignment','P14')
resource('groups','GroupCreate','P15',[('activate','ReasonAction')])
resource('intercompany-pairs','IntercompanyCreate','P15',[('accept','ApprovalDecision'),('post','Action')])
resource('consolidations','ConsolidationCreate','P15',[('preview','Action'),('approve','ApprovalDecision'),('publish','Action')])
resource('budgets','BudgetCreate','P16',[('approve','ApprovalDecision'),('activate','ReasonAction')])
resource('allocation-runs','AllocationRunCreate','P16',[('preview','Action'),('approve','ApprovalDecision'),('post','Action')])
resource('projects','ProjectCreate','P16',[('progress-billing','ProgressBilling')])
resource('leases','LeaseCreate','P17A',[('approve','ApprovalDecision')])
resource('discount-eligibility','DiscountEligibility','P17B',[('approve','ApprovalDecision')])
resource('report-definitions','ReportDefinitionCreate','P18A',[('publish','ApprovalDecision')])
resource('rule-proposals','RuleProposalCreate','P18B',[('impact','Action'),('approve','ApprovalDecision')])
resource('tool-grants','ToolGrantCreate','P18C',[('approve','ApprovalDecision'),('revoke','ReasonAction')])
add('post','/packs/install','P18D','pack.install','PackInstall',async_=True)
add('post','/demo/scenarios','P01','demo.select','DemoScenario',entity=False)
add('post','/demo/reset','P01','demo.reset','ReasonAction',async_=True,entity=False)
add('post','/demo/feedback','P01','demo.feedback','FeedbackCreate',entity=False)
for name in ['live','ready']:
    add('get','/health/'+name,'P00','health.read',response='Health',entity=False);paths['/health/'+name]['get']['security']=[]

paths['/imports']['post']['x-capability-by-kind']={'masters':'P03','openings':'P03','journal':'P03','bank_statement':'P06','inventory':'P10','assets':'P11','payroll_tax':'P07','tax_adjustments':'P07','payroll':'P17D','marketplace':'P17C','pos':'P17C','source_balances':'P08'}
paths['/open-items']['get']['description']='AR requires sales capability P04; AP requires purchasing P05. Filter/scope guards apply before totals.'
for method,path in [('post','/collections'),('patch','/collections/{id}')]:
    paths[path][method]['description']='Receipt direction only; payment direction is rejected. Check collections cannot post until their approved instrument clearing event. Unallocated receipts use the approved customer-advance account, not a fabricated invoice.'
for method,path in [('post','/settlements'),('patch','/settlements/{id}')]:
    paths[path][method]['description']='Payment direction only. Creates a proposal, never a cash posting. Payment authorization/release/settlement commands control the financial effect.'
for path,methods in paths.items():
    if path.startswith('/demo/'):
        for op in methods.values():op['x-demo-only']=True

# Polymorphic entity-specific HTTP constraints supplement shared document fields.
for endpoint,kind in [('invoices','invoice'),('bills','bill'),('sales-orders','sales_order'),('purchase-orders','purchase_order'),('expense-claims','expense_claim')]:
    for method in ['post','patch']:
        path='/'+endpoint+('/{id}' if method=='patch' else '')
        paths[path][method]['description']=paths[path][method].get('description','')+f' kind MUST be {kind}; different kind is 422. Totals and taxes are computed server-side.'

aliases={'entities':'entity','branches':'branch','parties':'party','memberships':'membership','roles':'role','approval-policies':'approval_policy','tasks':'task','obligations':'obligation','accounts':'account','journals':'journal','periods':'period','imports':'import','tax-rules':'tax_rule','invoices':'invoice','sales-orders':'sales_order','collections':'collection','bills':'bill','purchase-orders':'purchase_order','expense-claims':'expense_claim','payments':'payment','bank-accounts':'bank_account','bank-matches':'bank_match','transfers':'transfer','checks':'check','cash-sessions':'cash_session','returns':'return','source-ownership':'source_ownership','books':'book','fx-rates':'fx_rate','revaluations':'revaluation','items':'item','stock-movements':'stock_movement','stock-counts':'stock_count','landed-costs':'landed_cost','assets':'asset','schedules':'schedule','portal-invites':'portal_invite','message-requests':'message_request','payment-links':'payment_link','firm-mandates':'firm_mandate','firm-assignments':'firm_assignment','groups':'group','intercompany-pairs':'intercompany_pair','consolidations':'consolidation','budgets':'budget','allocation-runs':'allocation_run','projects':'project','leases':'lease','discount-eligibility':'discount_eligibility','report-definitions':'report_definition','rule-proposals':'rule_proposal','tool-grants':'tool_grant'}
for entry in operations:
    prefix,verb=entry['permission'].rsplit('.',1);prefix=aliases.get(prefix,prefix)
    if prefix in ['invoice','bill','journal','expense_claim'] and verb=='create':verb='prepare'
    permission=prefix+'.'+verb.replace('-','_');entry['permission']=permission
    paths[entry['path']][entry['method'].lower()]['x-required-permission']=permission
api={'openapi':'3.1.1','info':{'title':'LARA application contract','version':'1.0.0','description':'Normative internal application API. Provider schemas are separately certified artifacts. Demo operations are registered only on the isolated demo host.'},'servers':[{'url':'/v1'}],'security':[{'bearerAuth':[]}],'paths':paths,'components':{'securitySchemes':{'bearerAuth':{'type':'http','scheme':'bearer','bearerFormat':'JWT'}},'schemas':S}}
save('openapi.json',api);save('operations.json',operations)
save('permissions.json',{'version':1,'policy':'Deny by default; only these permissions may be assigned. Membership scope, field masking, maker-checker and activation gates are additional checks, not permission substitutions. Financial create permission means draft preparation, never implicit posting.','permissions':sorted({x['permission'] for x in operations})})

states={
'document':{'draft':['submitted','cancelled'],'submitted':['approved','changes_requested','cancelled'],'changes_requested':['draft'],'approved':['posted','draft'],'posted':[],'cancelled':[]},
'payment':{'draft':['submitted','cancelled'],'submitted':['authorized','draft','cancelled'],'authorized':['released','release_unknown','draft','cancelled'],'release_unknown':['released','failed'],'released':['settled','failed','returned'],'settled':['returned'],'failed':[],'returned':[],'cancelled':[]},
'transmission':{'not_applicable':[],'queued':['sending'],'sending':['accepted','rejected','unknown','retry_wait'],'unknown':['accepted','rejected','retry_wait'],'retry_wait':['sending'],'accepted':[],'rejected':[]},
'period':{'open':['soft_closed'],'soft_closed':['open','locked'],'locked':['open']},
'evidence':{'quarantined':['scanning','rejected'],'scanning':['available','rejected'],'available':[],'rejected':[]},
'job':{'queued':['running','cancelled'],'running':['succeeded','retry_wait','failed','dead_letter'],'retry_wait':['running','cancelled'],'succeeded':[],'failed':[],'dead_letter':[],'cancelled':[]}}
save('state-machines.json',{'version':1,'rules':'Transitions require role/version/policy/evidence guards in shared and phase specs. Posted financial corrections create linked documents. Reopening requires a new close version. Terminal provider rejection may create a new repaired payload job, never mutate accepted financial facts.','machines':states})

cases=[('AC-01','Invoice',[('AR','11200','0'),('Revenue','0','10000'),('OutputTax','0','1200')]),('AC-02','Collection',[('Bank','11200','0'),('AR','0','11200')]),('AC-03','Bill accrual withholding',[('Expense','10000','0'),('InputTax','1200','0'),('AP','0','11000'),('WithholdingPayable','0','200')]),('AC-04','Supplier payment',[('AP','11000','0'),('Bank','0','11000')]),('AC-05','Customer withholding receipt',[('Bank','11000','0'),('WithholdingReceivable','200','0'),('AR','0','11200')]),('AC-06','Partial credit',[('Revenue','5000','0'),('OutputTax','600','0'),('AR','0','5600')]),('AC-07','Bank fee',[('BankFees','50','0'),('Bank','0','50')]),('AC-08','Depreciation',[('Depreciation','2000','0'),('AccumulatedDepreciation','0','2000')]),('AC-09','FIFO issue',[('COGS','400','0'),('Inventory','0','400')]),('AC-10','FX settlement',[('Bank','5700','0'),('AR','0','5600'),('FXGain','0','100')])]
save('accounting-cases.json',{'purpose':'Synthetic fixtures only; not legal tax profiles. Each case is independent unless its test establishes the stated opening item.','cases':[{'id':id,'name':n,'functionalCurrency':'PHP','lines':[{'account':a,'debit':dr,'credit':cr} for a,dr,cr in lines]} for id,n,lines in cases]})
print(len(operations),'operations;',len(S),'schemas')
